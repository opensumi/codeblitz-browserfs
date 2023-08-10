import {
  BaseFileSystem,
  FileSystem,
  BFSCallback,
  FileSystemOptions,
} from '../core/file_system';
import { ApiError, ErrorCode } from '../core/api_error';
import { FileFlag, ActionType } from '../core/file_flag';
import { copyingSlice } from '../core/util';
import { File } from '../core/file';
import Stats, { FileType } from '../core/node_fs_stats';
import { NoSyncFile } from '../generic/preload_file';
import { FileIndex, FileInode, DirInode, isFileInode, isDirInode } from '../generic/file_index';
import * as paths from 'path';

/**
 * Try to convert the given buffer into a string, and pass it to the callback.
 * Optimization that removes the needed try/catch into a helper function, as
 * this is an uncommon case.
 * @hidden
 */
function tryToString(buff: Buffer, encoding: string, cb: BFSCallback<string>) {
  try {
    cb(null, buff.toString(encoding as BufferEncoding));
  } catch (e) {
    cb(e);
  }
}

function finallyPromise(promise: Promise<any>, onFinally: () => void | Promise<void>) {
  return promise.then(
    (value) => {
      return Promise.resolve(onFinally()).then(() => value);
    },
    (err) => {
      return Promise.resolve(onFinally()).then(() => { throw err; });
    }
  );
}

function wrap<T = any>(fn: (...args: any[]) => T | Promise<T>) {
  const cache = new Map<string, Promise<any>>();
  return function(this: any, ...args: any[]) {
    const key = args[0];
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const promise = Promise.resolve(fn.call(this, ...args));
    cache.set(key, promise);
    return finallyPromise(promise, () => {
      cache.delete(key);
    });
  };
}

type FileEntry = [string, FileType, any?];

interface FileStat {
  /**
   * 字节数
   */
  size: number;
}

export interface DynamicRequestOptions<T = any> {
  /**
   * 文件 metadata
   * 可选，无 stat 时，size 为 -1，在请求文件时会自动回填 file size
   */
  stat?(p: string, data?: T): FileStat | Promise<FileStat>;

  /**
   * 检索文件夹所有条目
   */
  readDirectory(p: string, data?: T): FileEntry[] | Promise<FileEntry[]>;

  /**
   * 读取文件内容
   */
  readFile(p: string, data?: T): Uint8Array | Promise<Uint8Array>;
}

/**
 * 通用请求文件只读文件系统
 */
export default class DynamicRequest<T = any> extends BaseFileSystem implements FileSystem {
  public static readonly Name = 'DynamicRequest';

  public static readonly Options: FileSystemOptions = {
    stat: {
      type: 'function',
      description: 'Retrieve metadata about a file',
      optional: true,
    },
    readDirectory: {
      type: 'function',
      description: 'Retrieve all entries of a directory',
    },
    readFile: {
      type: 'function',
      description: 'Read the entire contents of a file.',
    },
  };

  /**
   * Construct an CodeHost file system backend with the given options.
   * 可通过接口一次性加载所有文件，但对于工程较大时耗时较长，因此采用按需加载方式，初始只加载根目录
   */
  public static Create<T = any>(opts: DynamicRequestOptions, cb: BFSCallback<DynamicRequest>): void {
    const fs = new DynamicRequest<T>(opts);
    cb(null, fs);
  }

  public static isAvailable(): boolean {
    return true;
  }

  public readonly prefixUrl: string;
  private _index: FileIndex<{}>;
  private _stat?: (p: string, data?: T) => Promise<FileStat>;
  private _readDirectory: (p: string, data?: T) => Promise<FileEntry[]>;
  private _readFile: (p: string, data?: T) => Promise<Uint8Array>;

  public constructor(opts: DynamicRequestOptions) {
    super();
    this._index = new FileIndex();
    this._stat = opts.stat && wrap(opts.stat);
    this._readDirectory = wrap(opts.readDirectory);
    this._readFile = wrap(opts.readFile);
  }

  public empty(): void {
    this._index.fileIterator(function(file: Stats) {
      file.fileData = null;
    });
  }

  public getName(): string {
    return DynamicRequest.Name;
  }

  public diskSpace(path: string, cb: (total: number, free: number) => void): void {
    // Read-only file system. We could calculate the total space, but that's not
    // important right now.
    cb(0, 0);
  }

  public isReadOnly(): boolean {
    return true;
  }

  public supportsLinks(): boolean {
    return false;
  }

  public supportsProps(): boolean {
    return false;
  }

  public supportsSynch(): boolean {
    // 可以通过 XHR 来支持同步请求，通常业务并不需要，目前不支持同步，后续视实际情况决定
    return false;
  }

  /**
   * 加载填充文件节点
   * @param path 文件路径
   * @param loadBase 是否记载最后一层节点，对于 readdir，需要加载，对于 stat 和 open 无需记载
   */
  public loadEntry(path: string, loadBase: boolean) {
    const pathList = ['/']
      .concat(path.split('/').filter(Boolean))
      .slice(0, loadBase ? undefined : -1);
    let p = '';
    return new Promise<void>((resolve, reject) => {
      const next = (index: number) => {
        if (index >= pathList.length) {
          resolve();
          return;
        }
        p = paths.join(p, pathList[index]);
        const inode = this._index.getInode(p);
        if (!isDirInode<T>(inode)) {
          resolve();
          return;
        }
        if (inode.entriesLoaded) {
          next(index + 1);
          return;
        }
        this._readDirectory(p, inode.getExtendData())
          .then((entryList) => {
              (entryList || []).forEach(([name, fileType, extendData]) => {
                let node: DirInode<any> | FileInode<Stats>;
                if (fileType === FileType.DIRECTORY) {
                  node = new DirInode();
                } else {
                  // 默认权限 555 即文件 w+x
                  node = new FileInode(new Stats(FileType.FILE, -1, 0x16D));
                }
                node.setExtendData(extendData);
                this._index.addPathFast(paths.join(p, name), node);
              });
              inode.entriesLoaded = true;
              next(index + 1);
          })
          .catch(reject);
      };
      next(0);
    });
  }

  public stat(path: string, isLstat: boolean, cb: BFSCallback<Stats>): void {
    const inode = this._index.getInode(path);
    if (inode === null) {
      return cb(ApiError.ENOENT(path));
    }
    let stats: Stats;
    if (isFileInode<Stats>(inode)) {
      stats = inode.getData();
      if (stats.size < 0 && this._stat) {
        this._stat(path, inode.getExtendData())
          .then(({ size }) => {
            stats.size = size;
            cb(null, Stats.clone(stats));
          })
          .catch((e) => {
            cb(ApiError.FileError(ErrorCode.EINVAL, e && e.message || ''));
          });
      } else {
        cb(null, Stats.clone(stats));
      }
    } else if (isDirInode(inode)) {
      stats = inode.getStats();
      cb(null, stats);
    } else {
      cb(ApiError.FileError(ErrorCode.EINVAL, path));
    }
  }

  public open(path: string, flags: FileFlag, mode: number, cb: BFSCallback<File>): void {
    // INVARIANT: You can't write to files on this file system.
    if (flags.isWriteable()) {
      return cb(new ApiError(ErrorCode.EPERM, path));
    }
    const self = this;
    // Check if the path exists, and is a file.
    const inode = this._index.getInode(path);
    if (inode === null) {
      return cb(ApiError.ENOENT(path));
    }
    if (isFileInode<Stats>(inode)) {
      const stats = inode.getData();
      switch (flags.pathExistsAction()) {
        case ActionType.THROW_EXCEPTION:
        case ActionType.TRUNCATE_FILE:
          return cb(ApiError.EEXIST(path));
        case ActionType.NOP:
          if (stats.fileData) {
            return cb(null, new NoSyncFile(self, path, flags, Stats.clone(stats), stats.fileData));
          }
          this._readFile(path, inode.getExtendData())
            .then((content) => {
              const buf = Buffer.from(content);
              stats.size = buf!.length;
              stats.fileData = buf!;
              return cb(null, new NoSyncFile(self, path, flags, Stats.clone(stats), buf));
            })
            .catch((err) => {
              return cb(new ApiError(ErrorCode.EINVAL, err && err.message || ''));
            });
          break;
        default:
          return cb(new ApiError(ErrorCode.EINVAL, 'Invalid FileMode object.'));
      }
    } else {
      return cb(ApiError.EISDIR(path));
    }
  }

  public readdir(path: string, cb: BFSCallback<string[]>): void {
    try {
      const inode = this._index.getInode(path);
      if (inode === null) {
        cb(ApiError.ENOENT(path));
      } else if (isDirInode(inode)) {
        if (inode.entriesLoaded) {
          cb(null, inode.getListing());
        } else {
          cb(new ApiError(ErrorCode.EINVAL, 'Failed to readdir'));
        }
      } else {
        cb(ApiError.ENOTDIR(path));
      }
    } catch (e) {
      cb(e);
    }
  }

  /**
   * We have the entire file as a buffer; optimize readFile.
   */
  public readFile(
    fname: string,
    encoding: string,
    flag: FileFlag,
    cb: BFSCallback<string | Buffer>
  ): void {
    // Wrap cb in file closing code.
    const oldCb = cb;
    // Get file.
    this.open(fname, flag, 0x1a4, function(err: ApiError, fd?: File) {
      if (err) {
        return cb(err);
      }
      cb = function(err: ApiError, arg?: Buffer) {
        fd!.close(function(err2: any) {
          if (!err) {
            err = err2;
          }
          return oldCb(err, arg);
        });
      };
      const fdCast = <NoSyncFile<DynamicRequest>> fd;
      const fdBuff = <Buffer> fdCast.getBuffer();
      if (encoding === null) {
        cb(err, copyingSlice(fdBuff));
      } else {
        tryToString(fdBuff, encoding, cb);
      }
    });
  }
}

(['stat', 'open', 'readdir'] as ('stat' | 'open' | 'readdir')[]).forEach((method) => {
  const _rawFn = DynamicRequest.prototype[method];
  DynamicRequest.prototype[method] = function(this: DynamicRequest, path: string, ...args: any[]) {
    finallyPromise(this.loadEntry(path, method === 'readdir'), () => {
      _rawFn.call(this, path, ...args);
    });
  };
});

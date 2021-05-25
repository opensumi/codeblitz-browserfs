/**
 * Unit tests for DynamicRequest
 */
import fs from '../../../../src/core/node_fs';
import assert from '../../../harness/wrapped-assert';
import * as BrowserFS from '../../../../src/core/browserfs';
import { FileType } from '../../../../src/core/node_fs_stats';

export default function() {
  let oldRootFS = fs.getRootFS();

  const dirMap: Record<string, [string, FileType][]> = {
    '/': [
      ['README.md', FileType.FILE],
      ['test', FileType.DIRECTORY],
      ['src', FileType.DIRECTORY],
    ],
    '/test': [
      ['fixtures', FileType.DIRECTORY],
    ],
    '/test/fixtures': [
      ['static', FileType.DIRECTORY],
    ],
    '/test/fixtures/static': [
      ['49chars.txt', FileType.FILE],
    ],
    '/src': [
      ['README.md', FileType.FILE],
      ['backend', FileType.DIRECTORY],
      ['main.ts', FileType.FILE],
    ],
    '/src/backend': [
      ['AsyncMirror.ts', FileType.FILE],
      ['XmlHttpRequest.ts', FileType.FILE],
      ['ZipFS.ts', FileType.FILE],
    ]
  }

  BrowserFS.FileSystem.DynamicRequest.Create({
    readDirectory(p: string) {
      return dirMap[p];
    },
    readFile(p) {
      return fetch(p).then(res => res.arrayBuffer()).then(buf => new Uint8Array(buf))
    },
    stat(p) {
      return fetch(p, { method: 'HEAD' })
        .then(res => {
          const size = parseInt(res.headers.get('Content-Length') || '-1', 10)
          return { size }
        })
    }
  }, (e, newDRFS) => {
    BrowserFS.initialize(newDRFS);

    let t1text = 'Invariant fail: Can query folder that contains items and a mount point.';
    let expectedTestListing = ['README.md', 'src', 'test'];

    fs.readdir('/', function(err, files) {
      assert(!err, t1text);
      assert.deepEqual(files.sort(), expectedTestListing, t1text);
      fs.stat("/test/fixtures/static/49chars.txt", function(err, stats) {
        assert(!err, "Can stat an existing file");
        assert(stats.isFile(), "File should be interpreted as a file");
        assert(!stats.isDirectory(), "File should be interpreted as a directory");
        // NOTE: Size is 50 in Windows due to line endings.
        assert(stats.size == 49 || stats.size == 50, "file size should match");
      });

      fs.stat("/src/backend", function(err, stats) {
        assert(!err, "Can stat an existing directory");
        assert(stats.isDirectory(), "directory should be interpreted as a directory");
        assert(!stats.isFile(), "directory should be interpreted as a file");
      });

      fs.stat("/src/not-existing-name", function(err, stats) {
        assert(!!err, "Non existing file should return an error");
      });

    });
  });

  // Restore test FS on test end.
  process.on('exit', function() {
    BrowserFS.initialize(oldRootFS);
  });
};

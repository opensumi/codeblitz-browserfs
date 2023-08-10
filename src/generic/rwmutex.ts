import setImmediate from '../generic/setImmediate';
import Mutex from './mutex';

const rwmutexMaxReaders = 1 << 30;

/**
 * Non-recursive rwmutex
 * @hidden
 */
export default class RWMutex extends Mutex {
  private _readerWaiters: Function[] = [];
  private _writerWaiters: Function[] = [];
  private _readerCount: number = 0;
  private _readerWait: number = 0;

  public rLock(cb: Function): void {
    this._readerCount++;
    if (this._readerCount < 0) {
      this._readerWaiters.push(cb);
      return;
    }
    cb();
  }

  public rUnlock(): void {
    if (this._readerCount === 0 || this._readerCount === -rwmutexMaxReaders) {
      throw new Error('rUnlock of a non-locked rwmutex');
    }
    this._readerCount--;
    if (this._readerCount < 0) {
      this._readerWait -= 1;
      if (this._readerWait === 0) {
        const next = this._writerWaiters.shift();
        if (next) {
          setImmediate(next);
        }
      }
    }
  }

  public lock(cb: Function): void {
    super.lock(() => {
      this._readerWait += this._readerCount;
      this._readerCount -= rwmutexMaxReaders;
      if (this._readerWait) {
        this._writerWaiters.push(cb);
        return;
      }
      cb();
    });
  }

  public unlock(): void {
    if (this._readerCount >= 0) {
      throw new Error('unlock of a non-locked rwmutex');
    }
    this._readerCount += rwmutexMaxReaders;

    const count = this._readerWaiters.length;
    let i = 0;
    while (i < count) {
      const cb = this._readerWaiters.shift();
      if (cb) {
        setImmediate(cb);
      }
      i++;
    }

    super.unlock();
  }
}

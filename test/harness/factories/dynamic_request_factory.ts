import {FileSystem} from '../../../src/core/file_system';
import DynamicRequest from '../../../src/backend/DynamicRequest';
import {FileType} from '../../../src/core/node_fs_stats'

export default function DynamicRequestFSFactory(cb: (name: string, objs: FileSystem[]) => void): void {
  const dirMap: Record<string, [string, FileType][]> = {};
  fetch('test/fixtures/httpdownloadfs/listings.json')
    .then(data => data.json())
    .then((listing) => {
      const queue = [['/', listing]];
      while (queue.length > 0) {
        const next = queue.pop();
        const dir = next![0];
        const tree = next![1];
        if (!dirMap[dir]) {
          dirMap[dir] = []
        }
        for (const node in tree) {
          if (tree.hasOwnProperty(node)) {
            const children = tree[node];
            dirMap[dir].push([node, children ? FileType.DIRECTORY : FileType.FILE]);
            if (children) {
              queue.push([`${dir === '/' ? '' : dir}/${node}`, children])
            }
          }
        }
      }

      DynamicRequest.Create({
        readDirectory(p: string) {
          return Promise.resolve(dirMap[p]);
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
      }, (err, drfs) => {
        if (err) {
          throw err;
        }
        cb('DynamicRequest', [drfs])
      });
    })
    .catch(err => {
      console.error(err)
    })
}

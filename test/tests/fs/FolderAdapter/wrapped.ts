/**
* Unit tests for HTTPDownloadFS
*/
import fs from '../../../../src/core/node_fs';
import assert from '../../../harness/wrapped-assert';
import * as BrowserFS from '../../../../src/core/browserfs';

type Listing = {[name: string]: Listing | any};

export default function() {
  let oldRootFS = fs.getRootFS();

  let listing: Listing = {
    "README.md": null,
    "test": {
      "fixtures": {
        "static": {
          "49chars.txt": null
        }
      }
    },
    "src":{
      "README.md": null,
      "backend":{"AsyncMirror.ts": null, "XmlHttpRequest.ts": null, "ZipFS.ts": null},
      "main.ts": null
    }
  }

  BrowserFS.FileSystem.XmlHttpRequest.Create({
    index: listing,
    baseUrl: "/"
  }, (e, newXFS) => {

    BrowserFS.FileSystem.FolderAdapter.Create({
      wrapped: newXFS,
      folder: '/src'
    }, (e, folderFS) => {
      BrowserFS.initialize(folderFS);

      let t1text = 'Invariant fail: Can query folder that contains items and a mount point.';
      let expectedTestListing = ['README.md', 'backend', 'main.ts'];
      let testListing = fs.readdirSync('/').sort();
      assert.deepEqual(testListing, expectedTestListing, t1text);

      fs.readdir('/', function(err, files) {
        assert(!err, t1text);
        assert.deepEqual(files.sort(), expectedTestListing, t1text);

        fs.stat("/backend", function(err, stats) {
          assert(!err, "Can stat an existing directory");
          assert(stats.isDirectory(), "directory should be interpreted as a directory");
          assert(!stats.isFile(), "directory should be interpreted as a file");
        });

        fs.stat("/not-existing-name", function(err, stats) {
          assert(!!err, "Non existing file should return an error");
        });

      });
    })
  });

  assert(BrowserFS.FileSystem.XmlHttpRequest === BrowserFS.FileSystem.HTTPRequest, `Maintains XHR file system for backwards compatibility.`);

  // Restore test FS on test end.
  process.on('exit', function() {
    BrowserFS.initialize(oldRootFS);
  });
};

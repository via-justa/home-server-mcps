// isolated-vm ships prebuilds only for Node 22 and 24, and its source build fails on newer V8, so any
// other major breaks the install or every sandbox-backed test. Fail early with a clear message instead.
const major = Number(process.versions.node.split('.')[0]);
if (major !== 22 && major !== 24) {
  console.error(`synoikia needs Node.js 22 or 24 (isolated-vm has no build for others); found ${process.version}.`);
  process.exit(1);
}

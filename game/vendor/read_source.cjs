// Small helper shared by game/test scripts: read a file relative to this script, so test files
// can be run from any cwd without depending on process.cwd().
const fs = require('fs');
const path = require('path');
module.exports = { readFileSync };
function readFileSync(relative, enc) {
  return fs.readFileSync(path.resolve(__dirname, relative), enc);
}

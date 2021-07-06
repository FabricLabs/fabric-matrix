'use strict';

const Matrix = require('../services/matrix');
const settings = require('../settings/default');

async function main (input = {}) {
  const matrix = new Matrix(input);
  await matrix.start();
}

main(settings).catch((exception) => {
  console.log('[MATRIX:AGENT]', 'Main Process Exception:', exception);
}).then((output) => {
  console.log('[MATRIX:AGENT]', 'Main Process Output:', output);
});

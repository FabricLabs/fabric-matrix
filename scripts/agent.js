'use strict';

// Dependencies & Defaults
const Matrix = require('../services/matrix');
const settings = require('../settings/default');

// Contracts
const _handleLog = require('../contracts/_handleLog');
const _handleError = require('../contracts/_handleError');
const _handleMessage = require('../contracts/_handleMessage');
const _handleWarning = require('../contracts/_handleWarning');

// Main Process
async function main (input = {}) {
  // Instantiate our Service
  const matrix = new Matrix(input);

  // Listen for Events
  matrix.on('log', _handleLog);
  matrix.on('error', _handleError);
  matrix.on('message', _handleMessage);
  matrix.on('warning', _handleWarning);

  // Start our Service
  await matrix.start();

  // Return the State
  return {
    status: 'STARTING',
    object: matrix.state || input
  };
}

// Run `main()` and return the result
main(settings).catch((exception) => {
  _handleLog('[MATRIX:AGENT]', 'Main Process Exception:', exception);
}).then((output) => {
  _handleLog('[MATRIX:AGENT]', 'Main Process Output:', output);
});

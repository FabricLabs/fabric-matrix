const Message = require('@fabric/core/types/message');

module.exports = async function _handleMessage (...data) {
  if (data instanceof Message) {
    switch (data.type) {
      default:
        console.log(`[AUDIT] Unhandled Message type: ${data.type}`);
        break;
    }
  }

  console.log('[MESSAGE]', ...data);
};

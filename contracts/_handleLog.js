module.exports = async function _handleError (...data) {
  console.error((new Date()).toISOString(), ...data);
};

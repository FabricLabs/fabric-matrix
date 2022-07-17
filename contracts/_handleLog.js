module.exports = async function _handleLog (...data) {
  console.log((new Date()).toISOString(), ...data);
};

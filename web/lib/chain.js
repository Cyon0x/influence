const { ethers } = require('ethers');
const chainConfig = require('./chain-config.json');
const escrowAbi = require('./escrowAbi.json');

let _provider = null;
function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(
      chainConfig.rpcUrl,
      { chainId: chainConfig.chainId, name: 'arc-testnet' },
      { staticNetwork: true }
    );
  }
  return _provider;
}

function getEscrow() {
  return new ethers.Contract(chainConfig.escrowAddress, escrowAbi, getProvider());
}

const DEAL_STATUS = ['Active', 'ProofSubmitted', 'Completed', 'Cancelled'];

module.exports = { chainConfig, getProvider, getEscrow, DEAL_STATUS };

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { defineChain } from 'viem';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';

// Baked in at build time (Privy app IDs are meant to be public/client-side,
// not a secret) — see auth-widget/.env, set VITE_PRIVY_APP_ID and rebuild.
const APP_ID = import.meta.env.VITE_PRIVY_APP_ID;

// Arc testnet isn't one of viem's built-in chains, so Privy's embedded
// wallet has no idea it exists unless it's explicitly defined and passed
// as both defaultChain and (within) supportedChains below — without this,
// the embedded wallet has no chain to switch to, silently defeating the
// auto-network-switch this config exists for. Reads from window.INFLUENCE_CONFIG
// (loaded by config.js, guaranteed to run before this script — see index.html's
// script order) rather than hardcoding, so it can never drift out of sync with
// the rest of the app's contract/RPC config.
const CFG = window.INFLUENCE_CONFIG || {};
const arcTestnet = defineChain({
  id: CFG.chainId || 5042002,
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [CFG.rpcUrl || 'https://rpc.blockdaemon.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: CFG.explorer || 'https://testnet.arcscan.app' },
  },
});

// If Privy never becomes ready for any reason (misconfigured App ID, network
// failure, allowed-origins mismatch, an outage on their end), the widget
// must not leave `window.InfluenceAuth.ready` unresolved forever — anything
// doing `await window.InfluenceAuth.ready` before calling login() would hang
// with no error shown, indistinguishable from a slow network to the user.
const READY_TIMEOUT_MS = 8000;

const listeners = new Set();
function notify(state) {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error('InfluenceAuth listener error', err);
    }
  });
}

let resolveReady;
let readyResolved = false;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});
function markReady() {
  if (readyResolved) return;
  readyResolved = true;
  resolveReady();
}

// The plain, non-React API the vanilla-JS app.js actually calls. Defined
// unconditionally (even if APP_ID is missing, or Privy fails to load) so
// app.js can always safely probe window.InfluenceAuth without needing to
// know whether social login is configured or currently working.
window.InfluenceAuth = {
  ready: readyPromise,
  isReady: false,
  isAuthenticated: false,
  address: null,
  failed: false,
  login: () => console.warn('InfluenceAuth: unavailable — Privy did not initialize.'),
  logout: () => console.warn('InfluenceAuth: unavailable — Privy did not initialize.'),
  getProvider: async () => null,
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

class PrivyErrorBoundary extends React.Component {
  componentDidCatch(error) {
    console.error('InfluenceAuth: Privy failed to initialize', error);
    window.InfluenceAuth.failed = true;
    markReady();
  }
  render() {
    // Render nothing either way — this whole tree is a hidden bridge, never
    // meant to display anything itself, whether it errored or not.
    return this.state?.hasError ? null : this.props.children;
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
}

function Bridge() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    const embedded = wallets.find((w) => w.walletClientType === 'privy');
    const address = authenticated && embedded ? embedded.address : null;

    window.InfluenceAuth.isReady = ready;
    window.InfluenceAuth.isAuthenticated = authenticated;
    window.InfluenceAuth.address = address;
    window.InfluenceAuth.login = login;
    window.InfluenceAuth.logout = logout;
    window.InfluenceAuth.getProvider = embedded ? () => embedded.getEthereumProvider() : async () => null;

    if (ready) {
      markReady();
      notify({ ready, authenticated, address });
    }
  }, [ready, authenticated, wallets, login, logout]);

  return null;
}

if (!APP_ID) {
  console.warn('InfluenceAuth: VITE_PRIVY_APP_ID not set at build time — social login is disabled.');
  window.InfluenceAuth.failed = true;
  markReady();
} else {
  setTimeout(() => {
    if (!readyResolved) {
      console.warn('InfluenceAuth: Privy did not become ready within ' + READY_TIMEOUT_MS + 'ms — treating social login as unavailable.');
      window.InfluenceAuth.failed = true;
      markReady();
    }
  }, READY_TIMEOUT_MS);

  const mountEl = document.createElement('div');
  mountEl.id = 'influence-auth-widget-root';
  mountEl.style.display = 'none';
  document.body.appendChild(mountEl);

  createRoot(mountEl).render(
    <PrivyErrorBoundary>
      <PrivyProvider
        appId={APP_ID}
        config={{
          loginMethods: ['twitter', 'email'],
          embeddedWallets: { createOnLogin: 'users-without-wallets' },
          defaultChain: arcTestnet,
          supportedChains: [arcTestnet],
          appearance: {
            theme: 'dark',
            accentColor: '#FF6B35',
            logo: '/logo.png',
          },
        }}
      >
        <Bridge />
      </PrivyProvider>
    </PrivyErrorBoundary>
  );
}

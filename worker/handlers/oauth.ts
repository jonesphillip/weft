/**
 * OAuth handlers for GitHub and Google
 */

import {
  getOAuthUrl as getGitHubOAuthUrl,
  exchangeCodeForToken as exchangeGitHubCode,
  getUser as getGitHubUser,
  generateState,
} from '../github/oauth';
import {
  getOAuthUrl as getGoogleOAuthUrl,
  exchangeCodeForToken as exchangeGoogleCode,
  getUserInfo as getGoogleUser,
} from '../google/oauth';
import { getAccountByCredentialType, getMCPTools } from '../mcp/AccountMCPRegistry';
import { encodeOAuthState, decodeOAuthState } from '../utils/oauth-state';
import { jsonResponse } from '../utils/response';
import { CREDENTIAL_TYPES } from '../constants';
import { logger } from '../utils/logger';
import type { BoardDO } from '../BoardDO';

type BoardDOStub = DurableObjectStub<BoardDO>;

// ============================================
// PROVIDER CONFIGS
// ============================================

interface OAuthProvider {
  name: 'github' | 'google';
  credentialType: string;
  getClientId: (env: Env) => string | undefined;
  getClientSecret: (env: Env) => string | undefined;
  getOAuthUrl: (clientId: string, redirectUri: string, state: string) => string;
  exchangeCode: (code: string, clientId: string, clientSecret: string, redirectUri: string) => Promise<OAuthTokenData>;
  getUser: (token: string) => Promise<OAuthUserData>;
  buildCredential: (user: OAuthUserData, tokenData: OAuthTokenData) => {
    name: string;
    metadata: Record<string, unknown>;
  };
  callbackPath: string;
}

interface OAuthTokenData {
  access_token: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface OAuthUserData {
  id: string | number;
  login?: string;
  email?: string;
  name?: string | null;
  picture?: string;
}

const githubProvider: OAuthProvider = {
  name: 'github',
  credentialType: CREDENTIAL_TYPES.GITHUB_OAUTH,
  getClientId: (env) => env.GITHUB_CLIENT_ID,
  getClientSecret: (env) => env.GITHUB_CLIENT_SECRET,
  getOAuthUrl: getGitHubOAuthUrl,
  exchangeCode: exchangeGitHubCode,
  getUser: getGitHubUser,
  buildCredential: (user, tokenData) => ({
    name: `GitHub: ${user.login}`,
    metadata: {
      login: user.login,
      userId: user.id,
      scope: tokenData.scope,
    },
  }),
  callbackPath: '/github/callback',
};

const googleProvider: OAuthProvider = {
  name: 'google',
  credentialType: CREDENTIAL_TYPES.GOOGLE_OAUTH,
  getClientId: (env) => env.GOOGLE_CLIENT_ID,
  getClientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
  getOAuthUrl: getGoogleOAuthUrl,
  exchangeCode: exchangeGoogleCode,
  getUser: getGoogleUser,
  buildCredential: (user, tokenData) => ({
    name: `Google: ${user.email}`,
    metadata: {
      email: user.email,
      userId: user.id,
      name: user.name,
      picture: user.picture,
      scope: tokenData.scope,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    },
  }),
  callbackPath: '/google/callback',
};

// ============================================
// GENERIC OAUTH HANDLERS
// ============================================

async function handleOAuthUrl(
  request: Request,
  env: Env,
  url: URL,
  provider: OAuthProvider
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ success: false, error: { code: '405', message: 'Method not allowed' } }, 405);
  }

  const clientId = provider.getClientId(env);
  if (!clientId) {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_CONFIGURED', message: `${provider.name} OAuth not configured` },
    }, 500);
  }

  const boardId = url.searchParams.get('boardId');
  if (!boardId) {
    return jsonResponse({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'boardId is required' },
    }, 400);
  }

  const redirectUri = `${url.origin}${provider.callbackPath}`;
  const signedState = await encodeOAuthState(
    { boardId, nonce: generateState() },
    env.ENCRYPTION_KEY
  );

  const authUrl = provider.getOAuthUrl(clientId, redirectUri, signedState);

  return jsonResponse({
    success: true,
    data: { url: authUrl },
  });
}

async function handleOAuthExchange(
  env: Env,
  url: URL,
  provider: OAuthProvider
): Promise<Response> {
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');

  if (!code || !stateParam) {
    return jsonResponse({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Missing code or state parameter' },
    }, 400);
  }

  const clientId = provider.getClientId(env);
  const clientSecret = provider.getClientSecret(env);

  if (!clientId || !clientSecret) {
    return jsonResponse({
      success: false,
      error: { code: 'NOT_CONFIGURED', message: `${provider.name} OAuth not configured` },
    }, 500);
  }

  try {
    const state = await decodeOAuthState(stateParam, env.ENCRYPTION_KEY);
    if (!state) {
      return jsonResponse({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Invalid or expired state parameter' },
      }, 400);
    }

    const { boardId } = state;
    const redirectUri = `${url.origin}${provider.callbackPath}`;

    const tokenData = await provider.exchangeCode(code, clientId, clientSecret, redirectUri);
    const user = await provider.getUser(tokenData.access_token);

    // Store credential and create MCP servers
    await storeCredentialAndCreateMCPs(env, boardId, provider, user, tokenData);

    return jsonResponse({
      success: true,
      data: { boardId },
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: {
        code: 'OAUTH_FAILED',
        message: error instanceof Error ? error.message : 'OAuth failed',
      },
    }, 500);
  }
}

async function storeCredentialAndCreateMCPs(
  env: Env,
  boardId: string,
  provider: OAuthProvider,
  user: OAuthUserData,
  tokenData: OAuthTokenData
): Promise<void> {
  const doId = env.BOARD_DO.idFromName(boardId);
  const stub = env.BOARD_DO.get(doId) as BoardDOStub;

  const credentialData = provider.buildCredential(user, tokenData);

  // Check if credential already exists (re-authentication case)
  const existingCredentialId = await stub.findCredentialId(boardId, provider.credentialType);

  if (existingCredentialId) {
    await stub.updateCredentialValue(
      boardId,
      provider.credentialType,
      tokenData.access_token,
      credentialData.metadata
    );
  } else {
    const credential = await stub.createCredential(boardId, {
      type: provider.credentialType,
      name: credentialData.name,
      value: tokenData.access_token,
      metadata: credentialData.metadata,
    });

    if (!credential.id) return;
  }

  // Always ensure MCP servers exist (handles both new and re-auth cases)
  await ensureMCPServersExist(stub, boardId, provider);
}

/**
 * Ensure MCP servers exist for the account (handles both new and re-auth cases)
 * If MCPs already exist, this is a no-op. If not, creates them.
 */
async function ensureMCPServersExist(
  stub: BoardDOStub,
  boardId: string,
  provider: OAuthProvider
): Promise<void> {
  const account = getAccountByCredentialType(provider.credentialType);
  if (!account) {
    logger.auth.warn('No account found for credential type', { credentialType: provider.credentialType });
    return;
  }

  const existingServers = await stub.getMCPServers(boardId);
  const existingMcpIds = new Set(
    existingServers
      .filter(s => s.name && account.mcps.some(m => m.name === s.name))
      .map(s => s.name)
  );

  for (const mcp of account.mcps) {
    if (existingMcpIds.has(mcp.name)) {
      logger.auth.debug('MCP already exists', { mcpName: mcp.name, boardId });
      continue;
    }

    try {
      const server = await stub.createAccountMCP(boardId, {
        accountId: account.id,
        mcpId: mcp.id,
      });

      const tools = getMCPTools(account.id, mcp.id);
      if (tools.length > 0 && server.id) {
        await stub.cacheMCPServerTools(server.id, { tools });
      }

      logger.auth.info('Created MCP server', { mcpName: mcp.name, mcpId: mcp.id, boardId });
    } catch (error) {
      logger.auth.warn('Failed to create MCP server', {
        mcpName: mcp.name,
        mcpId: mcp.id,
        boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ============================================
// EXPORTED HANDLERS
// ============================================

export function handleGitHubOAuthUrl(request: Request, env: Env, url: URL): Promise<Response> {
  return handleOAuthUrl(request, env, url, githubProvider);
}

export function handleGitHubOAuthExchange(_request: Request, env: Env, url: URL): Promise<Response> {
  return handleOAuthExchange(env, url, githubProvider);
}

export async function handleGitHubOAuthCallback(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ success: false, error: { code: '405', message: 'Method not allowed' } }, 405);
  }

  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');

  if (!code || !stateParam) {
    return redirectWithError(url.origin, 'Missing code or state parameter');
  }

  const clientId = githubProvider.getClientId(env);
  const clientSecret = githubProvider.getClientSecret(env);

  if (!clientId || !clientSecret) {
    return redirectWithError(url.origin, 'GitHub OAuth not configured');
  }

  try {
    const state = await decodeOAuthState(stateParam, env.ENCRYPTION_KEY);
    if (!state) {
      return redirectWithError(url.origin, 'Invalid or expired state parameter');
    }

    const { boardId } = state;
    const redirectUri = `${url.origin}/api/github/oauth/callback`;

    const tokenData = await githubProvider.exchangeCode(code, clientId, clientSecret, redirectUri);
    const user = await githubProvider.getUser(tokenData.access_token);

    await storeCredentialAndCreateMCPs(env, boardId, githubProvider, user, tokenData);

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/board/${boardId}?github=connected`,
      },
    });
  } catch (error) {
    return redirectWithError(
      url.origin,
      error instanceof Error ? error.message : 'OAuth failed'
    );
  }
}

export function handleGoogleOAuthUrl(request: Request, env: Env, url: URL): Promise<Response> {
  return handleOAuthUrl(request, env, url, googleProvider);
}

export function handleGoogleOAuthExchange(_request: Request, env: Env, url: URL): Promise<Response> {
  return handleOAuthExchange(env, url, googleProvider);
}

function redirectWithError(origin: string, error: string): Response {
  const errorUrl = new URL(origin);
  errorUrl.searchParams.set('github_error', error);
  return new Response(null, {
    status: 302,
    headers: { Location: errorUrl.toString() },
  });
}

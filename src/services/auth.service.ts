import { google } from 'googleapis';

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  id_token?: string;
}

export interface UserProfile {
  email: string;
  name: string;
  picture: string;
  id: string;
}

export class AuthService {
  private oauth2Client: any = null;

  private getClient(): any {
    if (!this.oauth2Client) {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI;

      if (!clientId || !clientSecret) {
        throw new Error(
          'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment variables.'
        );
      }

      this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    }
    return this.oauth2Client;
  }

  getAuthUrl(state?: string): string {
    const client = this.getClient();
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    console.log('[GmailAuth] Generating OAuth URL with redirect_uri:', redirectUri);
    const params: any = {
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      redirect_uri: redirectUri,
    };
    if (state) {
      params.state = state;
    }
    return client.generateAuthUrl(params);
  }

  async getTokensFromCode(code: string): Promise<OAuthTokens> {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await client.getToken(code);
    return tokens as OAuthTokens;
  }

  private getProfileFromIdToken(tokens: OAuthTokens): UserProfile | null {
    if (!tokens.id_token) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf-8')
      );
      if (payload && payload.email) {
        return {
          email: payload.email || '',
          name: payload.name || '',
          picture: payload.picture || '',
          id: payload.sub || '',
        };
      }
    } catch {
      // Invalid id_token; fall through to the userinfo API
    }
    return null;
  }

  async getUserProfile(tokens: OAuthTokens): Promise<UserProfile> {
    const fromIdToken = this.getProfileFromIdToken(tokens);
    if (fromIdToken) {
      return fromIdToken;
    }
    const client = this.createClientWithTokens(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client } as any);
    const { data } = await oauth2.userinfo.get();
    return {
      email: data.email || '',
      name: data.name || '',
      picture: data.picture || '',
      id: data.id || '',
    };
  }

  createClientWithTokens(tokens: OAuthTokens): any {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;

    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    client.setCredentials(tokens);
    return client;
  }

  async refreshAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
    const client = this.createClientWithTokens(tokens);
    const { credentials } = await client.refreshAccessToken();
    return credentials as OAuthTokens;
  }
}

export const authService = new AuthService();

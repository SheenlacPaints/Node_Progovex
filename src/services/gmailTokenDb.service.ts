import { executeQuery, executeNonQuery } from '../config/database';
import { OAuthTokens } from './auth.service';

export interface GmailTokenRow {
  id: number;
  cuserid: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
  user_email: string;
  created_at: Date;
  updated_at: Date;
}

export class GmailTokenDbService {
  private static instance: GmailTokenDbService;
  static getInstance(): GmailTokenDbService {
    if (!GmailTokenDbService.instance) {
      GmailTokenDbService.instance = new GmailTokenDbService();
    }
    return GmailTokenDbService.instance;
  }

  async ensureTable(): Promise<void> {
    try {
      await executeQuery(`
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'nt_gmail_tokens')
        BEGIN
          CREATE TABLE nt_gmail_tokens (
            id INT IDENTITY(1,1) PRIMARY KEY,
            cuserid NVARCHAR(255) NOT NULL,
            access_token NVARCHAR(MAX) NOT NULL,
            refresh_token NVARCHAR(MAX) NOT NULL,
            scope NVARCHAR(500) NULL,
            token_type NVARCHAR(50) NULL,
            expiry_date BIGINT NULL,
            user_email NVARCHAR(255) NULL,
            created_at DATETIME DEFAULT GETDATE(),
            updated_at DATETIME DEFAULT GETDATE(),
            CONSTRAINT UQ_gmail_tokens_user UNIQUE(cuserid)
          );
          PRINT 'nt_gmail_tokens table created';
        END
      `);
      console.log('[GmailTokenDb] Table check/creation complete');
    } catch (error: any) {
      console.error('[GmailTokenDb] Table creation failed:', error.message);
    }
  }

  async getTokensByUserId(userId: string): Promise<OAuthTokens | null> {
    const rows = await executeQuery<GmailTokenRow[]>(
      'SELECT * FROM nt_gmail_tokens WHERE cuserid = @cuserid',
      { cuserid: userId }
    );
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      scope: row.scope || '',
      token_type: row.token_type || 'Bearer',
      expiry_date: row.expiry_date || 0,
    };
  }

  async getUserEmail(userId: string): Promise<string | null> {
    const rows = await executeQuery<GmailTokenRow[]>(
      'SELECT user_email FROM nt_gmail_tokens WHERE cuserid = @cuserid',
      { cuserid: userId }
    );
    if (!rows || rows.length === 0) return null;
    return rows[0].user_email || null;
  }

  async saveTokens(userId: string, tokens: OAuthTokens, userEmail?: string): Promise<void> {
    const existing = await this.getTokensByUserId(userId);
    if (existing) {
      await executeNonQuery(
        `UPDATE nt_gmail_tokens
         SET access_token = @access_token, refresh_token = @refresh_token,
             scope = @scope, token_type = @token_type, expiry_date = @expiry_date,
             user_email = @user_email, updated_at = GETDATE()
         WHERE cuserid = @cuserid`,
        {
          cuserid: userId,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope || '',
          token_type: tokens.token_type || 'Bearer',
          expiry_date: tokens.expiry_date || 0,
          user_email: userEmail || null,
        }
      );
    } else {
      await executeNonQuery(
        `INSERT INTO nt_gmail_tokens (cuserid, access_token, refresh_token, scope, token_type, expiry_date, user_email)
         VALUES (@cuserid, @access_token, @refresh_token, @scope, @token_type, @expiry_date, @user_email)`,
        {
          cuserid: userId,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope || '',
          token_type: tokens.token_type || 'Bearer',
          expiry_date: tokens.expiry_date || 0,
          user_email: userEmail || null,
        }
      );
    }
  }

  async updateTokens(userId: string, tokens: OAuthTokens): Promise<void> {
    await executeNonQuery(
      `UPDATE nt_gmail_tokens
       SET access_token = @access_token, scope = @scope, token_type = @token_type,
           expiry_date = @expiry_date, updated_at = GETDATE()
       WHERE cuserid = @cuserid`,
      {
        cuserid: userId,
        access_token: tokens.access_token,
        scope: tokens.scope || '',
        token_type: tokens.token_type || 'Bearer',
        expiry_date: tokens.expiry_date || 0,
      }
    );
  }

  async deleteTokens(userId: string): Promise<void> {
    await executeNonQuery(
      'DELETE FROM nt_gmail_tokens WHERE cuserid = @cuserid',
      { cuserid: userId }
    );
  }
}

export const gmailTokenDbService = GmailTokenDbService.getInstance();

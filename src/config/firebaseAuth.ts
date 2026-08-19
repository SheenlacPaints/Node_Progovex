import { GoogleAuth } from 'google-auth-library';
import { AuthRequest } from '../middleware/auth';

export class FirebaseTokenService {

  private type: string;
  private projectId: string;
  private privateKeyId: string;
  private privateKey: string;
  private clientEmail: string;
  FirebaseTokenService: any;

  constructor() {
    this.type         = process.env.FIREBASE_TYPE || 'service_account';
    this.projectId    = process.env.FIREBASE_PROJECT_ID || '';
    this.privateKeyId = process.env.FIREBASE_PRIVATE_KEY_ID || '';
    this.privateKey   = process.env.FIREBASE_PRIVATE_KEY || '';
    this.clientEmail  = process.env.FIREBASE_CLIENT_EMAIL || '';
  }

  public async getAccessTokenAsync(): Promise<string> {
    try {
      if (!this.projectId) {
        throw new Error( 'FIREBASE_PROJECT_ID is missing' );
      }

      if (!this.privateKey) {
        throw new Error( 'FIREBASE_PRIVATE_KEY is missing' );
      }

      if (!this.clientEmail) {
        throw new Error( 'FIREBASE_CLIENT_EMAIL is missing' );
      }

      // Same as C#:
      // _PrivateKey.Replace("\\n", "\n")

      const formattedPrivateKey = this.privateKey.replace(/\\n/g, '\n');

      const serviceAccount = {
        type            : this.type,
        project_id      : this.projectId,
        private_key_id  : this.privateKeyId,
        private_key     : formattedPrivateKey,
        client_email    : this.clientEmail
      };

      const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: [
          'https://www.googleapis.com/auth/firebase.messaging'
        ]
      });
      const client = await auth.getClient();

      const tokenResponse = await client.getAccessToken();
      if (!tokenResponse.token) {
        throw new Error( 'Failed to generate Firebase access token' );
      }
      return tokenResponse.token;
    } catch (error) {
      console.error( 'Firebase access token error:', error );
      throw error;
    }
  }

  // sendFirebaseNotification method to send notifications to Selected device
  public async sendSelectedUserNotify(req): Promise<string> {
    try {
      const token = await new FirebaseTokenService().getAccessTokenAsync();
      console.log('Access Token:');
      console.log(req);
      const tokens = req.userUrl; 
      console.log(tokens);       
      if (tokens.length > 0) {
        if (!token) {
            console.warn('⚠️  Firebase access token not obtained. Notifications will not be sent.');
        } else {
          // Send to each token using Firebase HTTP API
          for (const deviceToken of tokens) {
            try {
              const notificationData = {
                "message": {
                  "token": deviceToken,
                  "notification": {
                      "title": req.title,
                      "body": req.body
                  }
                }
              };
              console.log("notificationData");
              const fcmResponse = await fetch('https://fcm.googleapis.com/v1/projects/sheenlacnotifications/messages:send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(notificationData)
              });

              if (fcmResponse.ok) {
                  console.log(`🔔 FCM notification sent successfully`);
              } else {
                const errorData = await fcmResponse.text();
                console.error(`❌ FCM error:`, errorData);
              }
            } catch (tokenError) {
              console.error(`Error sending FCM for token:`, tokenError.message);
            }
          }
        }
      }
      return "All notifications marked as read successfully";
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        throw error;
    }
  }

  // sendFirebaseNotification method to send notifications to Selected device
  public async sendAllNotification(req): Promise<string> {
    try {
      const token = await new FirebaseTokenService().getAccessTokenAsync();
      console.log('Access Token:');
      console.log(req);
      const tokens = req;        
      if (tokens.length > 0) {
        if (!token) {
            console.warn('⚠️  Firebase access token not obtained. Notifications will not be sent.');
        } else {
          // Send to each token using Firebase HTTP API
          try {
            const notificationData = {
              "message": {
                "token": "deviceToken",
                "notification": {
                    "title": "New Post Notification",
                    "body": "Sheenlac Connect Notification"
                },
              }
            };
            console.log("notificationData");
            const fcmResponse = await fetch('https://fcm.googleapis.com/v1/projects/sheenlacnotifications/messages:send', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify(notificationData)
            });

            if (fcmResponse.ok) {
                console.log(`🔔 FCM notification sent successfully`);
            } else {
              const errorData = await fcmResponse.text();
              console.error(`❌ FCM error:`, errorData);
            }
          } catch (tokenError) {
            console.error(`Error sending FCM for token:`, tokenError.message);
          }
        }
      }
      return "All notifications marked as read successfully";
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        throw error;
    }
  }


}

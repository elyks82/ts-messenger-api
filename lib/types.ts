import { LogLevels } from 'npmlog';
import { Cookie } from 'tough-cookie';

export interface Credentials {
	email: string;
	password: string;
}

export interface ApiOptions {
	/** The desired logging level as determined by npmlog */
	logLevel?: LogLevels;
	/** Whether the api will receive messages from its own account. Default `false` */
	selfListen?: boolean;
	/** Will make `api.listen` also handle events. Default `false` */
	listenEvents?: boolean;
	/**
	 * Makes api.listen only receive messages through the page specified by that ID.
	 * Also makes `sendMessage` and `sendSticker` send from the page.
	 * Default empty
	 * */
	pageID?: string;
	/** Will make `api.listen` also return presence. Default `false` */
	updatePresence?: boolean;
	/** Will automatically approve of any recent logins and continue with the login process. Default `false` */
	forceLogin?: boolean;
	/** The desired simulated User Agent.
	 * Default `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_2) AppleWebKit/600.3.18 (KHTML, like Gecko) Version/8.0.3 Safari/600.3.18`
	 */
	userAgent?: string;
	/** Will automatically mark new messages as delivered. Default `true`*/
	autoMarkDelivery?: boolean;
	/** Will automatically mark new messages as read/seen. Default `false */
	autoMarkRead?: boolean;
	logRecordSize?: number;
}

/** Api context data */
export interface ApiCtx {
	userID: string;
	jar: any;
	clientID: string;
	globalOptions: ApiOptions;
	loggedIn: boolean;
	access_token: string;
	clientMutationId: number;
	mqttClient: any;
	lastSeqId: number;
	syncToken: any;
}

export type AppState = Cookie[];

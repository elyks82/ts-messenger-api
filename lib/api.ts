/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable no-case-declarations */
import stream from 'stream';
import log from 'npmlog';
import {
	ApiCtx,
	AppState,
	Dfs,
	ListenCallback,
	Message,
	MessageID,
	MessageReply,
	MqttQueue,
	OutgoingMessage,
	OutgoingMessageSendType,
	Presence,
	RequestForm,
	Typ
} from './types';
import { UserID, UserInfoGeneral, UserInfoGeneralDictByUserId } from './types/users';
import * as utils from './utils';
import mqtt from 'mqtt';
import websocket from 'websocket-stream';
import { ThreadColor, ThreadID } from './types/threads';
import { getAttachmentID, UploadGeneralAttachmentResponse } from './types/upload-attachment-response';

export default class Api {
	ctx: ApiCtx;
	private _defaultFuncs;

	private _topics = [
		'/t_ms',
		'/thread_typing',
		'/orca_typing_notifications',
		'/orca_presence',
		'/legacy_web',
		'/br_sr',
		'/sr_res',
		'/webrtc',
		'/onevc',
		'/notify_disconnect',
		'/inbox',
		'/mercury',
		'/messaging_events',
		'/orca_message_notifications',
		'/pp',
		'/webrtc_response'
	];
	private allowedProperties: { [index: string]: boolean } = {
		attachment: true,
		url: true,
		sticker: true,
		emoji: true,
		emojiSize: true,
		body: true,
		mentions: true
	};
	private chatOn = true;
	private foreground = false;

	constructor(defaultFuncs: Dfs, ctx: ApiCtx) {
		this.ctx = ctx;
		this._defaultFuncs = defaultFuncs;
	}

	logout(callback: (err?: any) => void): void {
		callback = callback || function () {};

		const form = {
			pmid: '0'
		};

		this._defaultFuncs
			.post(
				'https://www.facebook.com/bluebar/modern_settings_menu/?help_type=364455653583099&show_contextual_help=1',
				this.ctx.jar,
				form
			)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				const elem = resData.jsmods.instances[0][2][0].filter((v: any) => v.value === 'logout')[0];

				const html = resData.jsmods.markup.filter((v: any) => v[0] === elem.markup.__m)[0][1].__html;

				const form = {
					fb_dtsg: utils.getFrom(html, '"fb_dtsg" value="', '"'),
					ref: utils.getFrom(html, '"ref" value="', '"'),
					h: utils.getFrom(html, '"h" value="', '"')
				};

				return this._defaultFuncs
					.post('https://www.facebook.com/logout.php', this.ctx.jar, form)
					.then(utils.saveCookies(this.ctx.jar));
			})
			.then((res: any) => {
				if (!res.headers) {
					throw { error: 'An error occurred when logging out.' };
				}

				return this._defaultFuncs.get(res.headers.location, this.ctx.jar).then(utils.saveCookies(this.ctx.jar));
			})
			.then(() => {
				this.ctx.loggedIn = false;
				log.info('logout', 'Logged out successfully.');
				callback();
			})
			.catch((err: any) => {
				log.error('logout', err);
				return callback(err);
			});
	}

	getAppState(): AppState {
		return utils.getAppState(this.ctx.jar);
	}

	deleteMessage(messageOrMessages: MessageID[], callback = (err?: Error) => err): void {
		const form: RequestForm = {
			client: 'mercury'
		};

		for (let i = 0; i < messageOrMessages.length; i++) {
			form[`message_ids[${i}]`] = messageOrMessages[i];
		}

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/delete_messages.php', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(function (resData) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error('deleteMessage', err);
				return callback(err);
			});
	}

	/**
	 * @param callback Function that's called on every received message
	 * @returns Function that when called, stops listening
	 */
	listen(callback: ListenCallback): () => void {
		let globalCallback = callback;

		//Reset some stuff
		this.ctx.lastSeqId = 0;
		this.ctx.syncToken = undefined;

		//Same request as getThreadList
		const form = {
			av: this.ctx.globalOptions.pageID,
			queries: JSON.stringify({
				o0: {
					doc_id: '1349387578499440',
					query_params: {
						limit: 1,
						before: null,
						tags: ['INBOX'],
						includeDeliveryReceipts: false,
						includeSeqID: true
					}
				}
			})
		};

		this._defaultFuncs
			.post('https://www.facebook.com/api/graphqlbatch/', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(resData => {
				if (resData && resData.length > 0 && resData[resData.length - 1].error_results > 0) {
					throw resData[0].o0.errors;
				}

				if (resData[resData.length - 1].successful_results === 0) {
					throw { error: 'getSeqId: there was no successful_results', res: resData };
				}

				if (resData[0].o0.data.viewer.message_threads.sync_sequence_id) {
					this.ctx.lastSeqId = resData[0].o0.data.viewer.message_threads.sync_sequence_id;
					this._listenMqtt(globalCallback);
				}
			})
			.catch(err => {
				log.error('getSeqId', err);
				return callback(err);
			});

		return () => {
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			globalCallback = function () {};

			if (this.ctx.mqttClient) {
				this.ctx.mqttClient.end();
				this.ctx.mqttClient = undefined;
			}
		};
	}

	private _listenMqtt(globalCallback: ListenCallback) {
		const sessionID = Math.floor(Math.random() * 9007199254740991) + 1;
		const username = {
			u: this.ctx.userID,
			s: sessionID,
			chat_on: this.chatOn,
			fg: this.foreground,
			d: utils.getGUID(),
			ct: 'websocket',
			//App id from facebook
			aid: '219994525426954',
			mqtt_sid: '',
			cp: 3,
			ecp: 10,
			st: this._topics,
			pm: [],
			dc: '',
			no_auto_fg: true,
			gas: null
		};
		const cookies: string = this.ctx.jar.getCookies('https://www.facebook.com').join('; ');

		//Region could be changed for better ping. (Region atn: Southeast Asia, region ash: West US, prob) (Don't really know if we need it).
		//// const host = 'wss://edge-chat.facebook.com/chat?region=atn&sid=' + sessionID;
		const host = 'wss://edge-chat.facebook.com/chat?sid=' + sessionID;

		const options = {
			clientId: 'mqttwsclient',
			protocolId: 'MQIsdp',
			protocolVersion: 3,
			username: JSON.stringify(username),
			clean: true,
			wsOptions: {
				headers: {
					Cookie: cookies,
					Origin: 'https://www.facebook.com',
					'User-Agent': this.ctx.globalOptions.userAgent,
					Referer: 'https://www.facebook.com',
					Host: 'edge-chat.facebook.com'
				},
				origin: 'https://www.facebook.com',
				protocolVersion: 13
			}
		};

		this.ctx.mqttClient = new mqtt.Client(() => websocket(host, options.wsOptions), options);

		const mqttClient = this.ctx.mqttClient;

		mqttClient.on('error', (err: any) => {
			//TODO: This was modified
			log.error('err', err.message);
			mqttClient.end();
			globalCallback('Connection refused: Server unavailable');
		});

		mqttClient.on('connect', () => {
			let topic;
			const queue: MqttQueue = {
				sync_api_version: 10,
				max_deltas_able_to_process: 1000,
				delta_batch_size: 500,
				encoding: 'JSON',
				entity_fbid: this.ctx.userID
			};

			if (this.ctx.globalOptions.pageID) {
				queue.entity_fbid = this.ctx.globalOptions.pageID;
			}

			if (this.ctx.syncToken) {
				topic = '/messenger_sync_get_diffs';
				queue.last_seq_id = this.ctx.lastSeqId;
				queue.sync_token = this.ctx.syncToken;
			} else {
				topic = '/messenger_sync_create_queue';
				queue.initial_titan_sequence_id = this.ctx.lastSeqId;
				queue.device_params = null;
			}

			mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
		});
		mqttClient.on('message', (topic, message) => {
			//TODO: This was modified
			const jsonMessage = JSON.parse(message.toString());
			// if (jsonMessage?.deltas) console.log(jsonMessage?.deltas[0]?.requestContext);
			if (topic === '/t_ms') {
				if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
					this.ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
					this.ctx.syncToken = jsonMessage.syncToken;
				}

				if (jsonMessage.lastIssuedSeqId) {
					this.ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
				}

				if (
					jsonMessage.queueEntityId &&
					this.ctx.globalOptions.pageID &&
					this.ctx.globalOptions.pageID != jsonMessage.queueEntityId
				) {
					return;
				}

				//If it contains more than 1 delta
				for (const i in jsonMessage.deltas) {
					const delta = jsonMessage.deltas[i];
					this._parseDelta(globalCallback, { delta: delta });
				}
			} else if (topic === '/thread_typing' || topic === '/orca_typing_notifications') {
				const typ: Typ = {
					type: 'typ',
					isTyping: !!jsonMessage.state,
					from: jsonMessage.sender_fbid.toString(),
					threadID: utils.formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString())
				};
				(function () {
					globalCallback(undefined, typ);
				})();
			} else if (topic === '/orca_presence') {
				if (!this.ctx.globalOptions.updatePresence) {
					for (const i in jsonMessage.list) {
						const data = jsonMessage.list[i];
						const userID = data['u'];

						const presence: Presence = {
							type: 'presence',
							userID: userID.toString(),
							//Convert to ms
							timestamp: data['l'] * 1000,
							statuses: data['p']
						};
						(function () {
							globalCallback(undefined, presence);
						})();
					}
				}
			}
		});

		mqttClient.on('close', () => {
			// client.end();
			// console.log('CLOSED');
		});
	}

	/** This function disables the websocket connection and, consequently, disables message sending and receiving. */
	stopListening(): void {
		if (!this.ctx.mqttClient) return;
		this.ctx.mqttClient.end();
		this.ctx.mqttClient = undefined;
	}

	/** This value indicates whether the API listens for events and is able to send messages.
	 * This property is true if `API.listen` method was invoked. */
	get isActive(): boolean {
		return !!this.ctx.mqttClient;
	}
	private checkForActiveState() {
		if (!this.isActive) throw new Error('This function requires the function Api.listen() to be called first');
	}

	private websocketTaskNumber = 1;
	/** Creates and returns an object that can be JSON-stringified and sent using the websocket connection. */
	private createWebsocketContent(): any {
		return {
			request_id: 166, // TODO figure this out
			type: 3,
			payload: {
				version_id: '3816854585040595',
				tasks: [], // all tasks will be added here
				epoch_id: 6763184801413415579,
				data_trace_id: null
			},
			app_id: '772021112871879'
		};
	}
	private sendWebsocketContent(websocketContent: any, callback: (err?: unknown) => void): void {
		if (!this.ctx.mqttClient)
			return callback(new Error('This function requires the websocket client to be initialised.'));

		// json-stringify the payload property (if it hasn't been previously)
		// because (slightly retarded) Facebook requires it
		if (typeof websocketContent.payload === 'object')
			websocketContent.payload = JSON.stringify(websocketContent.payload);

		this.ctx.mqttClient.publish('/ls_req', JSON.stringify(websocketContent), {}, (err, packet) => {
			// console.log(err, packet);
			callback(err);
		});
	}

	private _parseDelta(globalCallback: ListenCallback, v: { delta: any }) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const that = this;
		if (v.delta.class == 'NewMessage') {
			(function resolveAttachmentUrl(i): void {
				// sometimes, with sticker message in group, delta does not contain 'attachments' property.
				if (v.delta.attachments && i == v.delta.attachments.length) {
					let fmtMsg;
					try {
						fmtMsg = utils.formatDeltaMessage(v);
					} catch (err) {
						return globalCallback({
							error:
								'Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.',
							detail: err,
							res: v,
							type: 'parse_error'
						});
					}
					if (fmtMsg) {
						if (that.ctx.globalOptions.autoMarkDelivery) {
							that._markDelivery(fmtMsg.threadID, fmtMsg.messageID);
						}
					}
					return !that.ctx.globalOptions.selfListen && fmtMsg.senderID === that.ctx.userID
						? undefined
						: (function () {
								globalCallback(undefined, fmtMsg);
						  })();
				} else {
					if (v.delta.attachments && v.delta.attachments[i].mercury.attach_type == 'photo') {
						that.resolvePhotoUrl(v.delta.attachments[i].fbid, (err?: Error, url?: string) => {
							if (!err) v.delta.attachments[i].mercury.metadata.url = url;
							return resolveAttachmentUrl(i + 1);
						});
					} else {
						return resolveAttachmentUrl(i + 1);
					}
				}
			})(0);
		}

		if (v.delta.class == 'ClientPayload') {
			const clientPayload = utils.decodeClientPayload(v.delta.payload);
			if (clientPayload && clientPayload.deltas) {
				for (const i in clientPayload.deltas) {
					const delta = clientPayload.deltas[i];
					if (delta.deltaMessageReaction && !!this.ctx.globalOptions.listenEvents) {
						(function () {
							globalCallback(undefined, {
								type: 'message_reaction',
								threadID: (delta.deltaMessageReaction.threadKey.threadFbId
									? delta.deltaMessageReaction.threadKey.threadFbId
									: delta.deltaMessageReaction.threadKey.otherUserFbId
								).toString(),
								messageID: delta.deltaMessageReaction.messageId,
								reaction: delta.deltaMessageReaction.reaction,
								senderID: delta.deltaMessageReaction.senderId.toString(),
								userID: delta.deltaMessageReaction.userId.toString()
							});
						})();
					} else if (delta.deltaRecallMessageData && !!this.ctx.globalOptions.listenEvents) {
						(function () {
							globalCallback(undefined, {
								type: 'message_unsend',
								threadID: (delta.deltaRecallMessageData.threadKey.threadFbId
									? delta.deltaRecallMessageData.threadKey.threadFbId
									: delta.deltaRecallMessageData.threadKey.otherUserFbId
								).toString(),
								messageID: delta.deltaRecallMessageData.messageID,
								senderID: delta.deltaRecallMessageData.senderID.toString(),
								deletionTimestamp: delta.deltaRecallMessageData.deletionTimestamp,
								timestamp: delta.deltaRecallMessageData.timestamp
							});
						})();
					} else if (delta.deltaMessageReply) {
						//Mention block - #1
						let mdata =
							delta.deltaMessageReply.message === undefined
								? []
								: delta.deltaMessageReply.message.data === undefined
								? []
								: delta.deltaMessageReply.message.data.prng === undefined
								? []
								: JSON.parse(delta.deltaMessageReply.message.data.prng);
						let m_id = mdata.map((u: any) => u.i);
						let m_offset = mdata.map((u: any) => u.o);
						let m_length = mdata.map((u: any) => u.l);

						const mentions: any = {};

						for (let i = 0; i < m_id.length; i++) {
							mentions[m_id[i]] = (delta.deltaMessageReply.message.body || '').substring(
								m_offset[i],
								m_offset[i] + m_length[i]
							);
						}
						//Mention block - 1#
						const callbackToReturn: MessageReply = {
							type: 'message_reply',
							threadID: (delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId
								? delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId
								: delta.deltaMessageReply.message.messageMetadata.threadKey.otherUserFbId
							).toString(),
							messageID: delta.deltaMessageReply.message.messageMetadata.messageId,
							senderID: delta.deltaMessageReply.message.messageMetadata.actorFbId.toString(),
							attachments: delta.deltaMessageReply.message.attachments
								.map(function (att: any) {
									const mercury = JSON.parse(att.mercuryJSON);
									Object.assign(att, mercury);
									return att;
								})
								.map((att: any) => {
									let x;
									try {
										x = utils._formatAttachment(att);
									} catch (ex) {
										x = att;
										x.error = ex;
										x.type = 'unknown';
									}
									return x;
								}),
							body: delta.deltaMessageReply.message.body || '',
							isGroup: !!delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId,
							mentions: mentions,
							timestamp: delta.deltaMessageReply.message.messageMetadata.timestamp
						};

						if (delta.deltaMessageReply.repliedToMessage) {
							//Mention block - #2
							mdata =
								delta.deltaMessageReply.repliedToMessage === undefined
									? []
									: delta.deltaMessageReply.repliedToMessage.data === undefined
									? []
									: delta.deltaMessageReply.repliedToMessage.data.prng === undefined
									? []
									: JSON.parse(delta.deltaMessageReply.repliedToMessage.data.prng);
							m_id = mdata.map((u: any) => u.i);
							m_offset = mdata.map((u: any) => u.o);
							m_length = mdata.map((u: any) => u.l);

							const rmentions: any = {};

							for (let i = 0; i < m_id.length; i++) {
								rmentions[m_id[i]] = (delta.deltaMessageReply.repliedToMessage.body || '').substring(
									m_offset[i],
									m_offset[i] + m_length[i]
								);
							}
							//Mention block - 2#
							callbackToReturn.messageReply = {
								type: 'message',
								threadID: (delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId
									? delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId
									: delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.otherUserFbId
								).toString(),
								messageID: delta.deltaMessageReply.repliedToMessage.messageMetadata.messageId,
								senderID: delta.deltaMessageReply.repliedToMessage.messageMetadata.actorFbId.toString(),
								attachments: delta.deltaMessageReply.repliedToMessage.attachments
									.map(function (att: any) {
										const mercury = JSON.parse(att.mercuryJSON);
										Object.assign(att, mercury);
										return att;
									})
									.map((att: any) => {
										let x;
										try {
											x = utils._formatAttachment(att);
										} catch (ex) {
											x = att;
											x.error = ex;
											x.type = 'unknown';
										}
										return x;
									}),
								body: delta.deltaMessageReply.repliedToMessage.body || '',
								isGroup: !!delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId,
								mentions: rmentions,
								timestamp: delta.deltaMessageReply.repliedToMessage.messageMetadata.timestamp
							};
						}

						if (this.ctx.globalOptions.autoMarkDelivery) {
							this._markDelivery(callbackToReturn.threadID, callbackToReturn.messageID);
						}

						return !this.ctx.globalOptions.selfListen && callbackToReturn.senderID === this.ctx.userID
							? undefined
							: (function () {
									globalCallback(undefined, callbackToReturn);
							  })();
					}
				}
				return;
			}
		}

		if (v.delta.class !== 'NewMessage' && !this.ctx.globalOptions.listenEvents) return;

		switch (v.delta.class) {
			case 'ReadReceipt':
				let fmtMsg;
				try {
					fmtMsg = utils.formatDeltaReadReceipt(v.delta);
				} catch (err) {
					return globalCallback({
						error:
							'Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.',
						detail: err,
						res: v.delta,
						type: 'parse_error'
					});
				}
				return (function () {
					globalCallback(undefined, fmtMsg);
				})();
			case 'AdminTextMessage':
				switch (v.delta.type) {
					case 'change_thread_theme':
					case 'change_thread_nickname':
					case 'change_thread_icon':
						break;
					case 'group_poll':
						let fmtMsg;
						try {
							fmtMsg = utils.formatDeltaEvent(v.delta);
						} catch (err) {
							return globalCallback({
								error:
									'Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.',
								detail: err,
								res: v.delta,
								type: 'parse_error'
							});
						}
						return (function () {
							globalCallback(undefined, fmtMsg);
						})();
					default:
						return;
				}
				break;
			//For group images
			case 'ForcedFetch':
				if (!v.delta.threadKey) return;
				const mid = v.delta.messageId;
				const tid = v.delta.threadKey.threadFbId;
				if (mid && tid) {
					const form = {
						av: this.ctx.globalOptions.pageID,
						queries: JSON.stringify({
							o0: {
								//This doc_id is valid as of ? (prob January 18, 2020)
								doc_id: '1768656253222505',
								query_params: {
									thread_and_message_id: {
										thread_id: tid.toString(),
										message_id: mid.toString()
									}
								}
							}
						})
					};

					this._defaultFuncs
						.post('https://www.facebook.com/api/graphqlbatch/', this.ctx.jar, form)
						.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
						.then(resData => {
							if (resData[resData.length - 1].error_results > 0) {
								throw resData[0].o0.errors;
							}

							if (resData[resData.length - 1].successful_results === 0) {
								throw { error: 'forcedFetch: there was no successful_results', res: resData };
							}

							const fetchData = resData[0].o0.data.message;
							if (fetchData && fetchData.__typename === 'ThreadImageMessage') {
								(!this.ctx.globalOptions.selfListen && fetchData.message_sender.id.toString() === this.ctx.userID) ||
								!this.ctx.loggedIn
									? undefined
									: (function () {
											globalCallback(undefined, {
												type: 'change_thread_image',
												threadID: utils.formatID(tid.toString()),
												snippet: fetchData.snippet,
												timestamp: fetchData.timestamp_precise,
												author: fetchData.message_sender.id,
												image: {
													attachmentID:
														fetchData.image_with_metadata && fetchData.image_with_metadata.legacy_attachment_id,
													width: fetchData.image_with_metadata && fetchData.image_with_metadata.original_dimensions.x,
													height: fetchData.image_with_metadata && fetchData.image_with_metadata.original_dimensions.y,
													url: fetchData.image_with_metadata && fetchData.image_with_metadata.preview.uri
												}
											});
									  })();
							}
						})
						.catch(err => {
							log.error('forcedFetch', err);
						});
				}
				break;
			case 'ThreadName':
			case 'ParticipantsAddedToGroupThread':
			case 'ParticipantLeftGroupThread':
				let formattedEvent;
				try {
					formattedEvent = utils.formatDeltaEvent(v.delta);
				} catch (err) {
					return globalCallback({
						error:
							'Problem parsing message object. Please open an issue at https://github.com/Schmavery/facebook-chat-api/issues.',
						detail: err,
						res: v.delta,
						type: 'parse_error'
					});
				}
				return (!this.ctx.globalOptions.selfListen && formattedEvent.author.toString() === this.ctx.userID) ||
					!this.ctx.loggedIn
					? undefined
					: (function () {
							globalCallback(undefined, formattedEvent);
					  })();
		}
	}

	private _markDelivery(threadID: ThreadID, messageID: MessageID) {
		if (threadID && messageID) {
			this.markAsDelivered(threadID, messageID, err => {
				if (err) {
					log.error('FIX THIS', err);
				} else {
					if (this.ctx.globalOptions.autoMarkRead) {
						this.markAsRead(threadID, undefined, err => {
							if (err) {
								log.error('FIX THIS', err);
							}
						});
					}
				}
			});
		}
	}

	resolvePhotoUrl(photoID: string, callback: (err?: Error, url?: string) => void): void {
		if (!callback) {
			throw { error: 'resolvePhotoUrl: need callback' };
		}

		this._defaultFuncs
			.get('https://www.facebook.com/mercury/attachments/photo', this.ctx.jar, {
				photo_id: photoID
			})
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(resData => {
				if (resData.error) {
					throw resData;
				}

				const photoUrl = resData.jsmods.require[0][3][0];

				return callback(undefined, photoUrl);
			})
			.catch(err => {
				log.error('resolvePhotoUrl', err);
				return callback(err);
			});
	}

	markAsDelivered(threadID: ThreadID, messageID: MessageID, callback: (err?: string) => void): void {
		if (!callback) {
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			callback = function () {};
		}

		if (!threadID || !messageID) {
			return callback('Error: messageID or threadID is not defined');
		}

		const form: any = {};

		form['message_ids[0]'] = messageID;
		form['thread_ids[' + threadID + '][0]'] = messageID;

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/delivery_receipts.php', this.ctx.jar, form)
			.then(utils.saveCookies(this.ctx.jar))
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(function (resData) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error('markAsDelivered', err);
				return callback(err);
			});
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	markAsRead(threadID: ThreadID, read = true, callback = (err?: any) => {}): void {
		const form: { [index: string]: string | boolean | number } = {};

		if (typeof this.ctx.globalOptions.pageID !== 'undefined') {
			form['source'] = 'PagesManagerMessagesInterface';
			form['request_user_id'] = this.ctx.globalOptions.pageID;
		}

		form['ids[' + threadID + ']'] = read;
		form['watermarkTimestamp'] = new Date().getTime();
		form['shouldSendReadReceipt'] = true;
		form['commerce_last_message_type'] = 'non_ad';
		form['titanOriginatedThreadId'] = utils.generateThreadingID(this.ctx.clientID);

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/change_read_status.php', this.ctx.jar, form)
			.then(utils.saveCookies(this.ctx.jar))
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(function (resData: any) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error('markAsRead', err);
				return callback(err);
			});
	}

	markAsReadAll(callback: (err?: any) => void): void {
		if (!callback) {
			callback = function () {};
		}

		const form = {
			folder: 'inbox'
		};

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/mark_folder_as_read.php', this.ctx.jar, form)
			.then(utils.saveCookies(this.ctx.jar))
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(function (resData) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error('markAsReadAll', err);
				return callback(err);
			});
	}

	/**
	 * Sends a message to a given thread.
	 * @param msg Contents of the message
	 * @param threadID ID of a thread to send the message to
	 * @param callback Will be called when the message was successfully sent or rejected
	 */
	sendMessage(msg: OutgoingMessage, threadID: ThreadID, callback: (err?: unknown) => void = () => {}): void {
		this.checkForActiveState();

		const wsContent = this.createWebsocketContent();
		let isWaiting = false; // waiting for attachments to upload, for example
		this.websocketTaskNumber++;

		if (msg.sticker) {
			wsContent.payload.tasks.push({
				label: '46',
				payload: JSON.stringify({
					thread_id: threadID,
					otid: utils.generateOfflineThreadingID(),
					source: 0,
					send_type: OutgoingMessageSendType.Sticker,
					sticker_id: msg.sticker
				}),
				queue_name: threadID.toString(),
				task_id: this.websocketTaskNumber,
				failure_count: null
			});
		}
		if (msg.attachment) {
			if (!(msg.attachment instanceof Array)) msg.attachment = [msg.attachment];
			isWaiting = true;

			this.uploadAttachment(msg.attachment, (err, files) => {
				if (err) return callback(err);
				if (!files) {
					isWaiting = false;
					return;
				}

				files.forEach(file => {
					// for each attachment id, create a new task (as Facebook does)
					wsContent.payload.tasks.push({
						label: '46',
						payload: JSON.stringify({
							thread_id: threadID,
							otid: utils.generateOfflineThreadingID(),
							source: 0,
							send_type: OutgoingMessageSendType.Attachment,
							text: msg.body ? msg.body : null,
							attachment_fbids: [getAttachmentID(file)] // here is the actual attachment ID
						}),
						queue_name: threadID.toString(),
						task_id: this.websocketTaskNumber++, // increment the task number after each task
						failure_count: null
					});
				});

				isWaiting = false;
				this.sendWebsocketContent(wsContent, callback); // TODO: re-do this when big ASYNC refactor
			});
		}
		// handle this only when there are no other properties, because they are handled in other statements
		if (msg.body && !msg.attachment && !msg.mentions) {
			wsContent.payload.tasks.push({
				label: '46',
				payload: JSON.stringify({
					thread_id: threadID,
					otid: utils.generateOfflineThreadingID(),
					source: 0,
					send_type: OutgoingMessageSendType.PlainText,
					text: msg.body ? msg.body : null
				}),
				queue_name: threadID.toString(),
				task_id: this.websocketTaskNumber,
				failure_count: null
			});
		}
		if (msg.mentions && msg.body) {
			wsContent.payload.tasks.push({
				label: '46',
				payload: JSON.stringify({
					thread_id: threadID,
					otid: utils.generateOfflineThreadingID(),
					source: 0,
					send_type: OutgoingMessageSendType.PlainText,
					text: msg.body,
					mention_data: {
						mention_ids: msg.mentions.map(m => m.id).join(),
						mention_offsets: utils
							.mentionsGetOffsetRecursive(
								msg.body,
								msg.mentions.map(m => m.name)
							)
							.join(),
						mention_lengths: msg.mentions.map(m => m.name.length).join(),
						mention_types: msg.mentions.map(() => 'p').join()
					}
				}),
				queue_name: threadID.toString(),
				task_id: this.websocketTaskNumber,
				failure_count: null
			});
		}

		if (!isWaiting)
			// waiting for the attachments to upload
			this.sendWebsocketContent(wsContent, callback);
	}

	unsendMessage(messageID: MessageID, callback: (err?: unknown) => void = () => {}): void {
		this.checkForActiveState();
		if (!messageID) throw new Error('Invalid input to unsendMessage method');

		const wsContent = this.createWebsocketContent();
		wsContent.payload.tasks.push({
			label: '33',
			payload: JSON.stringify({ message_id: messageID }),
			queue_name: 'unsend_message',
			task_id: this.websocketTaskNumber,
			failure_count: null
		});
		this.sendWebsocketContent(wsContent, callback);
	}

	forwardMessage(messageID: MessageID, threadID: ThreadID, callback: (err: unknown) => void): void {
		this.checkForActiveState();
		if (!(messageID && threadID)) callback(new Error('Invalid input to forwardMessage method'));

		const wsContent = this.createWebsocketContent();
		wsContent.payload.tasks.push({
			label: '46',
			payload: JSON.stringify({
				thread_id: threadID,
				otid: utils.generateOfflineThreadingID(),
				source: 65536,
				send_type: OutgoingMessageSendType.ForwardMessage,
				forwarded_msg_id: messageID
			}),
			queue_name: threadID.toString(),
			task_id: this.websocketTaskNumber,
			failure_count: null
		});
		this.sendWebsocketContent(wsContent, callback);
	}

	private uploadAttachment(
		attachments: stream.Readable[],
		callback: (err: unknown, files?: UploadGeneralAttachmentResponse[]) => void
	): void {
		const uploadingPromises = attachments.map(att => {
			if (!utils.isReadableStream(att))
				throw callback(new TypeError(`Attachment should be a readable stream and not ${utils.getType(att)}.`));

			const form = {
				upload_1024: att,
				voice_clip: 'true'
			};

			return this._defaultFuncs
				.postFormData('https://upload.facebook.com/ajax/mercury/upload.php', this.ctx.jar, form, {})
				.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
				.then((resData: any) => {
					if (resData.error) throw resData;

					// We have to return the data unformatted unless we want to change it back in sendMessage.
					return resData.payload.metadata[0] as UploadGeneralAttachmentResponse;
				});
		});

		Promise.all(uploadingPromises)
			.then((resData: UploadGeneralAttachmentResponse[]) => {
				callback(null, resData);
			})
			.catch(err => {
				log.error('uploadAttachment', err);
				return callback(err);
			});
	}

	getUserInfo(id: UserID | UserID[], callback: (err: any, info?: UserInfoGeneralDictByUserId) => void): void {
		if (!callback) {
			throw { error: 'getUserInfo: need callback' };
		}
		if (!(id instanceof Array)) id = [id];

		const form: { [index: string]: UserID } = {};
		id.map((v, i) => {
			form['ids[' + i + ']'] = v;
		});
		this._defaultFuncs
			.post('https://www.facebook.com/chat/user_info/', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(resData => {
				if (resData.error) {
					throw resData;
				}
				return callback(null, this.formatData(resData.payload.profiles));
			})
			.catch(function (err) {
				log.error('getUserInfo', err);
				return callback(err);
			});
	}
	private formatData(data: any): Map<UserID, UserInfoGeneral> {
		const retObj: UserInfoGeneralDictByUserId = new Map<UserID, UserInfoGeneral>();

		for (const prop in data) {
			if (Object.hasOwnProperty.call(data, prop)) {
				const innerObj = data[prop];
				retObj.set(prop, {
					name: innerObj.name,
					firstName: innerObj.firstName,
					vanity: innerObj.vanity,
					thumbSrc: innerObj.thumbSrc,
					profileUrl: innerObj.uri,
					gender: innerObj.gender,
					type: innerObj.type,
					isFriend: innerObj.is_friend,
					isBirthday: !!innerObj.is_birthday
				});
			}
		}

		return retObj;
	}

	// -1=permanent mute, 0=unmute, 60=one minute, 3600=one hour, etc.
	muteThread(threadID: ThreadID, muteSeconds: number, callback: (err?: any) => void): void {
		if (!callback) {
			callback = function () {};
		}

		const form = {
			thread_fbid: threadID,
			mute_settings: muteSeconds
		};

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/change_mute_thread.php', this.ctx.jar, form)
			.then(utils.saveCookies(this.ctx.jar))
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then(function (resData) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error('muteThread', err);
				return callback(err);
			});
	}

	deleteThread(threadOrThreads: ThreadID | ThreadID[], callback: (err?: any) => void): void {
		if (!callback) {
			callback = function () {};
		}

		const form: RequestForm = {
			client: 'mercury'
		};

		if (!(threadOrThreads instanceof Array)) {
			threadOrThreads = [threadOrThreads];
		}

		for (let i = 0; i < threadOrThreads.length; i++) {
			form['ids[' + i + ']'] = threadOrThreads[i];
		}

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/delete_thread.php', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch((err: any) => {
				log.error('deleteThread', err);
				return callback(err);
			});
	}

	addUserToGroup(userID: UserID | UserID[], threadID: ThreadID, callback: (err?: any) => void): void {
		if (!callback) {
			callback = function () {};
		}

		if (!(userID instanceof Array)) {
			userID = [userID];
		}

		const messageAndOTID = utils.generateOfflineThreadingID();
		const form: RequestForm = {
			client: 'mercury',
			action_type: 'ma-type:log-message',
			author: 'fbid:' + this.ctx.userID,
			thread_id: '',
			timestamp: Date.now(),
			timestamp_absolute: 'Today',
			timestamp_relative: utils.generateTimestampRelative(),
			timestamp_time_passed: '0',
			is_unread: false,
			is_cleared: false,
			is_forward: false,
			is_filtered_content: false,
			is_filtered_content_bh: false,
			is_filtered_content_account: false,
			is_spoof_warning: false,
			source: 'source:chat:web',
			'source_tags[0]': 'source:chat',
			log_message_type: 'log:subscribe',
			status: '0',
			offline_threading_id: messageAndOTID,
			message_id: messageAndOTID,
			threading_id: utils.generateThreadingID(this.ctx.clientID),
			manual_retry_cnt: '0',
			thread_fbid: threadID
		};

		for (let i = 0; i < userID.length; i++) {
			if (utils.getType(userID[i]) !== 'Number' && utils.getType(userID[i]) !== 'String') {
				throw {
					error: 'Elements of userID should be of type Number or String and not ' + utils.getType(userID[i]) + '.'
				};
			}

			form['log_message_data[added_participants][' + i + ']'] = 'fbid:' + userID[i];
		}

		this._defaultFuncs
			.post('https://www.facebook.com/messaging/send/', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (!resData) {
					throw { error: 'Add to group failed.' };
				}
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch((err: any) => {
				log.error('addUserToGroup', err);
				return callback(err);
			});
	}

	removeUserFromGroup(userID: UserID, threadID: ThreadID, callback: (err?: any) => void): void {
		const form = {
			uid: userID,
			tid: threadID
		};

		this._defaultFuncs
			.post('https://www.facebook.com/chat/remove_participants', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (!resData) {
					throw { error: 'Remove from group failed.' };
				}
				if (resData.error) {
					throw resData;
				}
				return callback();
			})
			.catch((err: any) => {
				log.error('removeUserFromGroup', err);
				return callback(err);
			});
	}

	changeAdminStatus(
		threadID: ThreadID,
		adminIDs: Array<UserID>,
		adminStatus: boolean,
		callback: (err?: any) => void
	): void {
		if (utils.getType(adminIDs) !== 'Array') {
			throw { error: 'changeAdminStatus: adminIDs must be an array or string' };
		}

		if (utils.getType(adminStatus) !== 'Boolean') {
			throw { error: 'changeAdminStatus: adminStatus must be a string' };
		}

		if (!callback) {
			callback = () => {};
		}

		if (utils.getType(callback) !== 'Function' && utils.getType(callback) !== 'AsyncFunction') {
			throw { error: 'changeAdminStatus: callback is not a function' };
		}

		const form: any = {
			thread_fbid: threadID
		};

		let i = 0;
		for (const u of adminIDs) {
			form[`admin_ids[${i++}]`] = u;
		}
		form['add'] = adminStatus;

		this._defaultFuncs
			.post('https://www.facebook.com/messaging/save_admins/?dpr=1', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (resData.error) {
					switch (resData.error) {
						case 1976004:
							throw { error: 'Cannot alter admin status: you are not an admin.', rawResponse: resData };
						case 1357031:
							throw { error: 'Cannot alter admin status: this thread is not a group chat.', rawResponse: resData };
						default:
							throw { error: 'Cannot alter admin status: unknown error.', rawResponse: resData };
					}
				}
				callback();
			})
			.catch(err => {
				log.error('changeAdminStatus', err);
				return callback(err);
			});
	}

	changeArchivedStatus(threadOrThreads: ThreadID | ThreadID[], archive: boolean, callback: (err?: any) => void): void {
		if (!callback) {
			callback = function () {};
		}

		const form: any = {};

		if (threadOrThreads instanceof Array) {
			for (let i = 0; i < threadOrThreads.length; i++) {
				form['ids[' + threadOrThreads[i] + ']'] = archive;
			}
		} else {
			form['ids[' + threadOrThreads + ']'] = archive;
		}

		this._defaultFuncs
			.post('https://www.facebook.com/ajax/mercury/change_archived_status.php', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (resData.error) {
					throw resData;
				}
				return callback();
			})
			.catch((err: any) => {
				log.error('changeArchivedStatus', err);
				return callback(err);
			});
	}

	changeBlockedStatus(userID: UserID, block: boolean, callback: (err?: any) => void): void {
		if (!callback) {
			callback = function () {};
		}
		if (block) {
			this._defaultFuncs
				.post(
					'https://www.facebook.com/nfx/block_messages/?thread_fbid=' + userID + '&location=www_chat_head',
					this.ctx.jar,
					{}
				)
				.then(utils.saveCookies(this.ctx.jar))
				.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
				.then((resData: any) => {
					if (resData.error) {
						throw resData;
					}
					this._defaultFuncs
						.post(
							'https://www.facebook.com' +
								(/action="(.+?)"+?/.exec(resData.jsmods.markup[0][1].__html) || '')[1].replace(/&amp;/g, '&'),
							this.ctx.jar,
							{}
						)
						.then(utils.saveCookies(this.ctx.jar))
						.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
						.then((_resData: any) => {
							if (_resData.error) {
								throw _resData;
							}
							return callback();
						});
				})
				.catch(function (err) {
					log.error('changeBlockedStatus', err);
					return callback(err);
				});
		} else {
			this._defaultFuncs
				.post(
					'https://www.facebook.com/ajax/nfx/messenger_undo_block.php?story_location=messenger&context=%7B%22reportable_ent_token%22%3A%22' +
						userID +
						'%22%2C%22initial_action_name%22%3A%22BLOCK_MESSAGES%22%7D&',
					this.ctx.jar,
					{}
				)
				.then(utils.saveCookies(this.ctx.jar))
				.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
				.then((resData: any) => {
					if (resData.error) {
						throw resData;
					}
					return callback();
				})
				.catch((err: any) => {
					log.error('changeBlockedStatus', err);
					return callback(err);
				});
		}
	}

	changeThreadEmoji(emoji: string, threadID: ThreadID, callback: (err?: any) => void): void {
		const form = {
			emoji_choice: emoji,
			thread_or_other_fbid: threadID
		};

		this._defaultFuncs
			.post(
				'https://www.facebook.com/messaging/save_thread_emoji/?source=thread_settings&__pc=EXP1%3Amessengerdotcom_pkg',
				this.ctx.jar,
				form
			)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (resData.error === 1357031) {
					throw {
						error:
							"Trying to change emoji of a chat that doesn't exist. Have at least one message in the thread before trying to change the emoji."
					};
				}
				if (resData.error) {
					throw resData;
				}
				return callback();
			})
			.catch((err: any) => {
				log.error('changeThreadEmoji', err);
				return callback(err);
			});
	}

	getFriendsList(callback: (err?: any, info?: any) => void): void {
		this._defaultFuncs
			.postFormData('https://www.facebook.com/chat/user_info_all', this.ctx.jar, {}, { viewer: this.ctx.userID })
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (!resData) throw { error: 'getFriendsList returned empty object.' };
				if (resData.error) throw resData;
				callback(null, resData);
			})
			.catch((err: any) => {
				log.error('getFriendsList', err);
				return callback(err);
			});
	}

	getThreadHistory(
		threadID: ThreadID,
		amount: number,
		timestamp: number | undefined,
		callback: (err: any, history?: Message[]) => void
	): void {
		// `queries` has to be a string. I couldn't tell from the dev console. This
		// took me a really long time to figure out. I deserve a cookie for this.
		const form = {
			av: this.ctx.globalOptions.pageID,
			queries: JSON.stringify({
				o0: {
					// This doc_id was valid on February 2nd 2017.
					doc_id: '1498317363570230',
					query_params: {
						id: threadID,
						message_limit: amount,
						load_messages: 1,
						load_read_receipts: false,
						before: timestamp
					}
				}
			})
		};

		this._defaultFuncs
			.post('https://www.facebook.com/api/graphqlbatch/', this.ctx.jar, form)
			.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
			.then((resData: any) => {
				if (resData.error) {
					throw resData;
				}
				// This returns us an array of things. The last one is the success /
				// failure one.
				// @TODO What do we do in this case?
				if (resData[resData.length - 1].error_results !== 0) {
					throw new Error('well darn there was an error_result');
				}

				callback(null, this.formatMessagesGraphQLResponse(resData[0]));
			})
			.catch(function (err) {
				log.error('getThreadHistoryGraphQL', err);
				return callback(err);
			});
	}

	private formatMessagesGraphQLResponse(data: any) {
		const messageThread = data.o0.data.message_thread;
		const threadID = messageThread.thread_key.thread_fbid
			? messageThread.thread_key.thread_fbid
			: messageThread.thread_key.other_user_id;

		const messages = messageThread.messages.nodes.map((d: any) => {
			switch (d.__typename) {
				case 'UserMessage':
					// Give priority to stickers. They're seen as normal messages but we've
					// been considering them as attachments.
					let maybeStickerAttachment;
					if (d.sticker && d.sticker.pack) {
						maybeStickerAttachment = [
							{
								type: 'sticker',
								ID: d.sticker.id,
								url: d.sticker.url,

								packID: d.sticker.pack ? d.sticker.pack.id : null,
								spriteUrl: d.sticker.sprite_image,
								spriteUrl2x: d.sticker.sprite_image_2x,
								width: d.sticker.width,
								height: d.sticker.height,

								caption: d.snippet, // Not sure what the heck caption was.
								description: d.sticker.label, // Not sure about this one either.

								frameCount: d.sticker.frame_count,
								frameRate: d.sticker.frame_rate,
								framesPerRow: d.sticker.frames_per_row,
								framesPerCol: d.sticker.frames_per_col,

								stickerID: d.sticker.id, // @Legacy
								spriteURI: d.sticker.sprite_image, // @Legacy
								spriteURI2x: d.sticker.sprite_image_2x // @Legacy
							}
						];
					}

					const mentionsObj: { [key: string]: string } = {};
					if (d.message !== null) {
						d.message.ranges.forEach((e: any) => {
							mentionsObj[e.entity.id] = d.message.text.substr(e.offset, e.length);
						});
					}

					return {
						type: 'message',
						attachments: maybeStickerAttachment
							? maybeStickerAttachment
							: d.blob_attachments && d.blob_attachments.length > 0
							? d.blob_attachments.map(this.formatAttachmentsGraphQLResponse)
							: d.extensible_attachment
							? [this.formatExtensibleAttachment(d.extensible_attachment)]
							: [],
						body: d.message !== null ? d.message.text : '',
						isGroup: messageThread.thread_type === 'GROUP',
						messageID: d.message_id,
						senderID: d.message_sender.id,
						threadID: threadID,
						timestamp: d.timestamp_precise,

						mentions: mentionsObj,
						isUnread: d.unread,

						// New
						messageReactions: d.message_reactions ? d.message_reactions.map(this.formatReactionsGraphQL) : null,
						isSponsored: d.is_sponsored,
						snippet: d.snippet
					};
				case 'ThreadNameMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						eventType: 'change_thread_name',
						snippet: d.snippet,
						eventData: {
							threadName: d.thread_name
						},

						// @Legacy
						author: d.message_sender.id,
						logMessageType: 'log:thread-name',
						logMessageData: { name: d.thread_name }
					};
				case 'ThreadImageMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						eventType: 'change_thread_image',
						snippet: d.snippet,
						eventData:
							d.image_with_metadata == null
								? {} /* removed image */
								: {
										/* image added */
										threadImage: {
											attachmentID: d.image_with_metadata.legacy_attachment_id,
											width: d.image_with_metadata.original_dimensions.x,
											height: d.image_with_metadata.original_dimensions.y,
											url: d.image_with_metadata.preview.uri
										}
								  },

						// @Legacy
						logMessageType: 'log:thread-icon',
						logMessageData: {
							thread_icon: d.image_with_metadata ? d.image_with_metadata.preview.uri : null
						}
					};
				case 'ParticipantLeftMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						eventType: 'remove_participants',
						snippet: d.snippet,
						eventData: {
							// Array of IDs.
							participantsRemoved: d.participants_removed.map((p: any) => {
								return p.id;
							})
						},

						// @Legacy
						logMessageType: 'log:unsubscribe',
						logMessageData: {
							leftParticipantFbId: d.participants_removed.map((p: any) => {
								return p.id;
							})
						}
					};
				case 'ParticipantsAddedMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						eventType: 'add_participants',
						snippet: d.snippet,
						eventData: {
							// Array of IDs.
							participantsAdded: d.participants_added.map((p: any) => {
								return p.id;
							})
						},

						// @Legacy
						logMessageType: 'log:subscribe',
						logMessageData: {
							addedParticipants: d.participants_added.map((p: any) => {
								return p.id;
							})
						}
					};
				case 'VideoCallMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						eventType: 'video_call',
						snippet: d.snippet,

						// @Legacy
						logMessageType: 'other'
					};
				case 'VoiceCallMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						eventType: 'voice_call',
						snippet: d.snippet,

						// @Legacy
						logMessageType: 'other'
					};
				case 'GenericAdminTextMessage':
					return {
						type: 'event',
						messageID: d.message_id,
						threadID: threadID,
						isGroup: messageThread.thread_type === 'GROUP',
						senderID: d.message_sender.id,
						timestamp: d.timestamp_precise,
						snippet: d.snippet,
						eventType: d.extensible_message_admin_text_type.toLowerCase(),
						eventData: this.formatEventData(d.extensible_message_admin_text),

						// @Legacy
						logMessageType: utils.getAdminTextMessageType(d.extensible_message_admin_text_type),
						logMessageData: d.extensible_message_admin_text // Maybe different?
					};
				default:
					return { error: "Don't know about message type " + d.__typename };
			}
		});
		return messages;
	}

	private formatReactionsGraphQL(reaction: any) {
		return {
			reaction: reaction.reaction,
			userID: reaction.user.id
		};
	}

	private formatEventData(event: any) {
		if (event == null) {
			return {};
		}

		switch (event.__typename) {
			case 'ThemeColorExtensibleMessageAdminText':
				return {
					color: event.theme_color
				};
			case 'ThreadNicknameExtensibleMessageAdminText':
				return {
					nickname: event.nickname,
					participantID: event.participant_id
				};
			case 'ThreadIconExtensibleMessageAdminText':
				return {
					threadIcon: event.thread_icon
				};
			case 'InstantGameUpdateExtensibleMessageAdminText':
				return {
					gameID: event.game == null ? null : event.game.id,
					update_type: event.update_type,
					collapsed_text: event.collapsed_text,
					expanded_text: event.expanded_text,
					instant_game_update_data: event.instant_game_update_data
				};
			case 'GameScoreExtensibleMessageAdminText':
				return {
					game_type: event.game_type
				};
			case 'RtcCallLogExtensibleMessageAdminText':
				return {
					event: event.event,
					is_video_call: event.is_video_call,
					server_info_data: event.server_info_data
				};
			case 'GroupPollExtensibleMessageAdminText':
				return {
					event_type: event.event_type,
					total_count: event.total_count,
					question: event.question
				};
			case 'AcceptPendingThreadExtensibleMessageAdminText':
				return {
					accepter_id: event.accepter_id,
					requester_id: event.requester_id
				};
			case 'ConfirmFriendRequestExtensibleMessageAdminText':
				return {
					friend_request_recipient: event.friend_request_recipient,
					friend_request_sender: event.friend_request_sender
				};
			case 'AddContactExtensibleMessageAdminText':
				return {
					contact_added_id: event.contact_added_id,
					contact_adder_id: event.contact_adder_id
				};
			case 'AdExtensibleMessageAdminText':
				return {
					ad_client_token: event.ad_client_token,
					ad_id: event.ad_id,
					ad_preferences_link: event.ad_preferences_link,
					ad_properties: event.ad_properties
				};
			// never data
			case 'ParticipantJoinedGroupCallExtensibleMessageAdminText':
			case 'ThreadEphemeralTtlModeExtensibleMessageAdminText':
			case 'StartedSharingVideoExtensibleMessageAdminText':
			case 'LightweightEventCreateExtensibleMessageAdminText':
			case 'LightweightEventNotifyExtensibleMessageAdminText':
			case 'LightweightEventNotifyBeforeEventExtensibleMessageAdminText':
			case 'LightweightEventUpdateTitleExtensibleMessageAdminText':
			case 'LightweightEventUpdateTimeExtensibleMessageAdminText':
			case 'LightweightEventUpdateLocationExtensibleMessageAdminText':
			case 'LightweightEventDeleteExtensibleMessageAdminText':
				return {};
			default:
				return {
					error: "Don't know what to with event data type " + event.__typename
				};
		}
	}

	private formatAttachmentsGraphQLResponse(attachment: any) {
		switch (attachment.__typename) {
			case 'MessageImage':
				return {
					type: 'photo',
					ID: attachment.legacy_attachment_id,
					filename: attachment.filename,
					thumbnailUrl: attachment.thumbnail.uri,

					previewUrl: attachment.preview.uri,
					previewWidth: attachment.preview.width,
					previewHeight: attachment.preview.height,

					largePreviewUrl: attachment.large_preview.uri,
					largePreviewHeight: attachment.large_preview.height,
					largePreviewWidth: attachment.large_preview.width,

					// You have to query for the real image. See below.
					url: attachment.large_preview.uri, // @Legacy
					width: attachment.large_preview.width, // @Legacy
					height: attachment.large_preview.height, // @Legacy
					name: attachment.filename, // @Legacy

					// @Undocumented
					attributionApp: attachment.attribution_app
						? {
								attributionAppID: attachment.attribution_app.id,
								name: attachment.attribution_app.name,
								logo: attachment.attribution_app.square_logo
						  }
						: null

					// @TODO No idea what this is, should we expose it?
					//      Ben - July 15th 2017
					// renderAsSticker: attachment.render_as_sticker,

					// This is _not_ the real URI, this is still just a large preview.
					// To get the URL we'll need to support a POST query to
					//
					//    https://www.facebook.com/webgraphql/query/
					//
					// With the following query params:
					//
					//    query_id:728987990612546
					//    variables:{"id":"100009069356507","photoID":"10213724771692996"}
					//    dpr:1
					//
					// No special form though.
				};
			case 'MessageAnimatedImage':
				return {
					type: 'animated_image',
					ID: attachment.legacy_attachment_id,
					filename: attachment.filename,

					previewUrl: attachment.preview_image.uri,
					previewWidth: attachment.preview_image.width,
					previewHeight: attachment.preview_image.height,

					url: attachment.animated_image.uri,
					width: attachment.animated_image.width,
					height: attachment.animated_image.height,

					thumbnailUrl: attachment.preview_image.uri, // @Legacy
					name: attachment.filename, // @Legacy
					facebookUrl: attachment.animated_image.uri, // @Legacy
					rawGifImage: attachment.animated_image.uri, // @Legacy
					animatedGifUrl: attachment.animated_image.uri, // @Legacy
					animatedGifPreviewUrl: attachment.preview_image.uri, // @Legacy
					animatedWebpUrl: attachment.animated_image.uri, // @Legacy
					animatedWebpPreviewUrl: attachment.preview_image.uri, // @Legacy

					// @Undocumented
					attributionApp: attachment.attribution_app
						? {
								attributionAppID: attachment.attribution_app.id,
								name: attachment.attribution_app.name,
								logo: attachment.attribution_app.square_logo
						  }
						: null
				};
			case 'MessageVideo':
				return {
					type: 'video',
					filename: attachment.filename,
					ID: attachment.legacy_attachment_id,

					thumbnailUrl: attachment.large_image.uri, // @Legacy

					previewUrl: attachment.large_image.uri,
					previewWidth: attachment.large_image.width,
					previewHeight: attachment.large_image.height,

					url: attachment.playable_url,
					width: attachment.original_dimensions.x,
					height: attachment.original_dimensions.y,

					duration: attachment.playable_duration_in_ms,
					videoType: attachment.video_type.toLowerCase()
				};
				break;
			case 'MessageFile':
				return {
					type: 'file',
					filename: attachment.filename,
					ID: attachment.message_file_fbid,

					url: attachment.url,
					isMalicious: attachment.is_malicious,
					contentType: attachment.content_type,

					name: attachment.filename, // @Legacy
					mimeType: '', // @Legacy
					fileSize: -1 // @Legacy
				};
			case 'MessageAudio':
				return {
					type: 'audio',
					filename: attachment.filename,
					ID: attachment.url_shimhash, // Not fowardable

					audioType: attachment.audio_type,
					duration: attachment.playable_duration_in_ms,
					url: attachment.playable_url,

					isVoiceMail: attachment.is_voicemail
				};
			default:
				return {
					error: "Don't know about attachment type " + attachment.__typename
				};
		}
	}

	private formatExtensibleAttachment(attachment: any) {
		if (attachment.story_attachment) {
			return {
				type: 'share',
				ID: attachment.legacy_attachment_id,
				url: attachment.story_attachment.url,

				title: attachment.story_attachment.title_with_entities.text,
				description: attachment.story_attachment.description && attachment.story_attachment.description.text,
				source: attachment.story_attachment.source == null ? null : attachment.story_attachment.source.text,

				image:
					attachment.story_attachment.media == null
						? null
						: attachment.story_attachment.media.animated_image == null &&
						  attachment.story_attachment.media.image == null
						? null
						: (attachment.story_attachment.media.animated_image || attachment.story_attachment.media.image).uri,
				width:
					attachment.story_attachment.media == null
						? null
						: attachment.story_attachment.media.animated_image == null &&
						  attachment.story_attachment.media.image == null
						? null
						: (attachment.story_attachment.media.animated_image || attachment.story_attachment.media.image).width,
				height:
					attachment.story_attachment.media == null
						? null
						: attachment.story_attachment.media.animated_image == null &&
						  attachment.story_attachment.media.image == null
						? null
						: (attachment.story_attachment.media.animated_image || attachment.story_attachment.media.image).height,
				playable: attachment.story_attachment.media == null ? null : attachment.story_attachment.media.is_playable,
				duration:
					attachment.story_attachment.media == null ? null : attachment.story_attachment.media.playable_duration_in_ms,
				playableUrl: attachment.story_attachment.media == null ? null : attachment.story_attachment.media.playable_url,

				subattachments: attachment.story_attachment.subattachments,

				// Format example:
				//
				//   [{
				//     key: "width",
				//     value: { text: "1280" }
				//   }]
				//
				// That we turn into:
				//
				//   {
				//     width: "1280"
				//   }
				//
				properties: attachment.story_attachment.properties.reduce((obj: any, cur: any) => {
					obj[cur.key] = cur.value.text;
					return obj;
				}, {}),

				// Deprecated fields
				animatedImageSize: '', // @Legacy
				facebookUrl: '', // @Legacy
				styleList: '', // @Legacy
				target: '', // @Legacy
				thumbnailUrl:
					attachment.story_attachment.media == null
						? null
						: attachment.story_attachment.media.animated_image == null &&
						  attachment.story_attachment.media.image == null
						? null
						: (attachment.story_attachment.media.animated_image || attachment.story_attachment.media.image).uri, // @Legacy
				thumbnailWidth:
					attachment.story_attachment.media == null
						? null
						: attachment.story_attachment.media.animated_image == null &&
						  attachment.story_attachment.media.image == null
						? null
						: (attachment.story_attachment.media.animated_image || attachment.story_attachment.media.image).width, // @Legacy
				thumbnailHeight:
					attachment.story_attachment.media == null
						? null
						: attachment.story_attachment.media.animated_image == null &&
						  attachment.story_attachment.media.image == null
						? null
						: (attachment.story_attachment.media.animated_image || attachment.story_attachment.media.image).height // @Legacy
			};
		} else {
			return { error: "Don't know what to do with extensible_attachment." };
		}
	}
}

import stream from 'stream';
import log from 'npmlog';
import { ApiCtx, Dfs, OutgoingMessage } from '../types';
import { getAttachmentID, UploadGeneralAttachmentResponse } from '../types/upload-attachment-response';
import * as utils from '../utils';
import { ThreadID } from '../types/threads';

export enum OutgoingMessageSendType {
	PlainText = 1,
	Sticker = 2,
	Attachment = 3
}

export class OutgoingMessageHandler {
	// private handleUrl(
	// 	msg: OutgoingMessage,
	// 	form: RequestForm,
	// 	callback: (err?: { error: string }) => void,
	// 	cb: () => void
	// ): void {
	// 	if (msg.url) {
	// 		form['shareable_attachment[share_type]'] = '100';
	// 		this.getUrl(msg.url, function (err, params) {
	// 			if (err) {
	// 				return callback(err);
	// 			}

	// 			form['shareable_attachment[share_params]'] = params;
	// 			cb();
	// 		});
	// 	} else {
	// 		cb();
	// 	}
	// }

	// private handleSticker(
	// 	msg: OutgoingMessage,
	// 	form: RequestForm,
	// 	callback: (err?: { error: string }) => void,
	// 	cb: () => void
	// ): void {
	// 	if (msg.sticker) {
	// 		form['sticker_id'] = msg.sticker;
	// 	}
	// 	cb();
	// }

	// private handleEmoji(
	// 	msg: OutgoingMessage,
	// 	form: RequestForm,
	// 	callback: (err?: { error: string }) => void,
	// 	cb: () => void
	// ): void {
	// 	if (msg.emojiSize != null && msg.emoji == null) {
	// 		return callback({ error: 'emoji property is empty' });
	// 	}
	// 	if (msg.emoji) {
	// 		if (msg.emojiSize == null) {
	// 			msg.emojiSize = 'medium';
	// 		}
	// 		if (msg.emojiSize != 'small' && msg.emojiSize != 'medium' && msg.emojiSize != 'large') {
	// 			return callback({ error: 'emojiSize property is invalid' });
	// 		}
	// 		if (form['body'] != null && form['body'] != '') {
	// 			return callback({ error: 'body is not empty' });
	// 		}
	// 		form['body'] = msg.emoji;
	// 		form['tags[0]'] = 'hot_emoji_size:' + msg.emojiSize;
	// 	}
	// 	cb();
	// }

	private handleAttachment(msg: OutgoingMessage, threadID: ThreadID, callback: (err?: any) => void): void {
		if (msg.attachment) {
			if (!(msg.attachment instanceof Array)) msg.attachment = [msg.attachment];

			this.uploadAttachment(msg.attachment, (err, files) => {
				if (err) return callback(err);

				const attachmentIDs = files?.map(file => getAttachmentID(file));
				attachmentIDs?.forEach(attID => {
					// for each attachment id, create a new task and place it in the websocketContent
					this.websocketContent.payload.tasks.push({
						label: '46',
						payload: JSON.stringify({
							thread_id: threadID,
							otid: utils.generateOfflineThreadingID(),
							source: 0,
							send_type: OutgoingMessageSendType.Attachment,
							text: msg.body ? msg.body : null,
							attachment_fbids: [attID] // here is the actual attachment ID
						}),
						queue_name: threadID.toString(),
						task_id: 36, // TODO: finish this (increments each time)
						failure_count: null
					});
				});
				callback();
			});
		} else callback();
	}

	private handlePlainText(msg: OutgoingMessage, threadID: ThreadID, callback: (err?: any) => void): void {
		if (msg.body && !msg.attachment) {
			// TODO: handle also the mentions
			this.websocketContent.payload.tasks.push({
				label: '46',
				payload: JSON.stringify({
					thread_id: threadID,
					otid: utils.generateOfflineThreadingID(),
					source: 0,
					send_type: OutgoingMessageSendType.PlainText,
					text: msg.body ? msg.body : null
				}),
				queue_name: threadID.toString(),
				task_id: 35, // TODO: finish this (increments each time)
				failure_count: null
			});
		}
		callback();
	}

	// private handleMention(
	// 	msg: OutgoingMessage,
	// 	form: RequestForm,
	// 	callback: (err?: { error: string }) => void,
	// 	cb: () => void
	// ): void {
	// 	if (msg.mentions && msg.body) {
	// 		for (let i = 0; i < msg.mentions.length; i++) {
	// 			const mention = msg.mentions[i];

	// 			const tag = mention.tag;
	// 			if (typeof tag !== 'string') {
	// 				return callback({ error: 'Mention tags must be strings.' });
	// 			}

	// 			const offset = msg.body.indexOf(tag, mention.fromIndex || 0);

	// 			if (offset < 0) {
	// 				log.warn('handleMention', 'Mention for "' + tag + '" not found in message string.');
	// 			}

	// 			if (mention.id == null) {
	// 				log.warn('handleMention', 'Mention id should be non-null.');
	// 			}

	// 			const id = mention.id || 0;
	// 			form['profile_xmd[' + i + '][offset]'] = offset;
	// 			form['profile_xmd[' + i + '][length]'] = tag.length;
	// 			form['profile_xmd[' + i + '][id]'] = id;
	// 			form['profile_xmd[' + i + '][type]'] = 'p';
	// 		}
	// 	}
	// 	cb();
	// }

	websocketContent: any = {
		request_id: 166,
		type: 3,
		payload: {
			// this payload will be json-stringified
			version_id: '3816854585040595',
			tasks: [],
			epoch_id: 6763184801413415579,
			data_trace_id: null
		},
		app_id: '772021112871879'
	};
	constructor(private ctx: ApiCtx, private _defaultFuncs: Dfs) {}

	handleAllAttachments(
		msg: OutgoingMessage,
		threadID: ThreadID,
		callback: (err?: any, websocketContent?: any) => void
	): void {
		this.handleAttachment(
			msg,
			threadID,
			() =>
				this.handlePlainText(msg, threadID, () => {
					// this.handleSticker(msg, errorCallback, () =>
					// this.handleUrl(msg, errorCallback, () =>
					// this.handleEmoji(msg, errorCallback, () => this.handleMention(msg, errorCallback, () => {}))

					// finally, stringify the last payload - as Facebook requires
					this.websocketContent.payload = JSON.stringify(this.websocketContent.payload);

					callback(null, this.websocketContent);
				})
			// )
			// )
		);
	}

	// private getUrl(url: string, callback: (err?: { error: string }, params?: any) => void): void {
	// 	const form = {
	// 		image_height: 960,
	// 		image_width: 960,
	// 		uri: url
	// 	};

	// 	this._defaultFuncs
	// 		.post('https://www.facebook.com/message_share_attachment/fromURI/', this.ctx.jar, form)
	// 		.then(utils.parseAndCheckLogin(this.ctx, this._defaultFuncs))
	// 		.then((resData: any) => {
	// 			if (resData.error) {
	// 				return callback(resData);
	// 			}

	// 			if (!resData.payload) {
	// 				return callback({ error: 'Invalid url' });
	// 			}

	// 			callback(undefined, resData.payload.share_data.share_params);
	// 		})
	// 		.catch((err: any) => {
	// 			log.error('getUrl', err);
	// 			return callback(err);
	// 		});
	// }

	private uploadAttachment(
		attachments: stream.Readable[],
		callback: (err?: any, files?: UploadGeneralAttachmentResponse[]) => void
	): void {
		const uploadingPromises = attachments.map(att => {
			if (!utils.isReadableStream(att))
				throw new TypeError(`Attachment should be a readable stream and not ${utils.getType(att)}.`);

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
				callback(undefined, resData);
			})
			.catch(err => {
				log.error('uploadAttachment', err);
				return callback(err);
			});
	}
}

import {
	commands,
	workspace,
	window,
	ExtensionContext,
	Range,
	Disposable,
	Comment,
	MarkdownString,
	CommentMode,
	CommentAuthorInformation,
	CommentThread,
	CommentReply,
	CommentThreadCollapsibleState,
	comments,
	TextDocument,
	CancellationToken,
	Uri,
	WorkspaceConfiguration,
} from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let commentId = 1;
const default_author = "Unknown"

class NoteComment implements Comment {
	id: number;
	label: string | undefined;
	savedBody: string | MarkdownString; // for the Cancel button
	constructor(
		public body: string | MarkdownString,
		public mode: CommentMode,
		public author: CommentAuthorInformation,
		public parent?: CommentThread,
		public contextValue?: string
	) {
		this.id = ++commentId;
		this.savedBody = this.body;
	}

	toJSON() {
		return {
			body: this.body,
			mode: this.mode,
			author: this.author,
			contextValue: this.contextValue,
		}
	}

	static fromJSON(comment: any) {
		return new NoteComment(
			comment.body,
			comment.mode,
			comment.author,
			undefined,
			comment.contextValue
		)
	}
}


export class WorkspaceContext {
	private commentController;
	private commands: Disposable[] = [];
	private threads = new Set<CommentThread>();

	constructor(private context: ExtensionContext, public workspaceRoot: string) {
		// A `CommentController` is able to provide comments for documents.
		this.commentController = comments.createCommentController('textfile_comments', 'Textfile Comments');
		context.subscriptions.push(this.commentController);

		// A `CommentingRangeProvider` controls where gutter decorations that allow adding comments are shown
		this.commentController.commentingRangeProvider = {
			provideCommentingRanges: (document: TextDocument, token: CancellationToken) => {
				const lineCount = document.lineCount;
				return [new Range(0, 0, lineCount - 1, 0)];
			}
		};
		this.readThreads();
	}
	get filePath(): fs.PathLike {
		return path.join(this.workspaceRoot, this.config.get('filename')!)
	}

	get config(): WorkspaceConfiguration {
		return workspace.getConfiguration("textfile_comments")
	}

	get author(): string {
		return this.config.get('author')!
	}

	watchConfiguration() {
		workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('code-review.filename')) {
				this.refreshCommands();
			}
		});
	}

	registerCommands() {
		let createNote = commands.registerCommand('textfile_comments.createNote', (reply: CommentReply) => {
			this.replyNote(reply);
		})
		this.commands.push(createNote)
		this.context.subscriptions.push(createNote);


		let replyNote = commands.registerCommand('textfile_comments.replyNote', (reply: CommentReply) => {
			this.replyNote(reply);
		})
		this.commands.push(replyNote);
		this.context.subscriptions.push(replyNote);

		let startDraft = commands.registerCommand('textfile_comments.startDraft', (reply: CommentReply) => {
			const thread = reply.thread;
			thread.contextValue = 'draft';
			const newComment = new NoteComment(reply.text, CommentMode.Preview, { name: this.author }, thread);
			newComment.label = 'pending';
			thread.comments = [...thread.comments, newComment];
		})
		this.commands.push(startDraft);
		this.context.subscriptions.push(startDraft);

		let finishDraft = commands.registerCommand('textfile_comments.finishDraft', (reply: CommentReply) => {
			const thread = reply.thread;

			if (!thread) {
				return;
			}

			thread.contextValue = undefined;
			thread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
			if (reply.text) {
				const newComment = new NoteComment(reply.text, CommentMode.Preview, { name: this.author }, thread);
				thread.comments = [...thread.comments, newComment].map(comment => {
					comment.label = "open";
					return comment;
				});
			}
			this.saveThread(reply.thread);
		})
		this.commands.push(finishDraft);
		this.context.subscriptions.push(finishDraft);

		let deleteNoteComment = commands.registerCommand('textfile_comments.deleteNoteComment', (comment: NoteComment) => {
			const thread = comment.parent;
			if (!thread) {
				return;
			}

			thread.comments = thread.comments.filter(cmt => (cmt as NoteComment).id !== comment.id);

			if (thread.comments.length === 0) {
				this.deleteThread(thread)
			} else {
				this.writeThreads()
			}
		})
		this.commands.push(deleteNoteComment);
		this.context.subscriptions.push(deleteNoteComment);

		let deleteNote = commands.registerCommand('textfile_comments.deleteNote', (thread: CommentThread) => {
			this.deleteThread(thread)
		})
		this.commands.push(deleteNote);
		this.context.subscriptions.push(deleteNote);

		let cancelsaveNote = commands.registerCommand('textfile_comments.cancelsaveNote', (comment: NoteComment) => {
			if (!comment.parent) {
				return;
			}

			comment.parent.comments = comment.parent.comments.map(cmt => {
				if ((cmt as NoteComment).id === comment.id) {
					cmt.body = (cmt as NoteComment).savedBody;
					cmt.mode = CommentMode.Preview;
				}

				return cmt;
			});
		})
		this.commands.push(cancelsaveNote);
		this.context.subscriptions.push(cancelsaveNote);

		let saveNote = commands.registerCommand('textfile_comments.saveNote', (comment: NoteComment) => {
			if (!comment.parent) {
				return;
			}

			comment.parent.comments = comment.parent.comments.map(cmt => {
				if ((cmt as NoteComment).id === comment.id) {
					(cmt as NoteComment).savedBody = cmt.body;
					cmt.mode = CommentMode.Preview;
				}

				return cmt;
			});
			this.saveThread(comment.parent)
		})
		this.commands.push(saveNote);
		this.context.subscriptions.push(saveNote);

		let editNote = commands.registerCommand('textfile_comments.editNote', (comment: NoteComment) => {
			if (!comment.parent) {
				return;
			}

			comment.parent.comments = comment.parent.comments.map(cmt => {
				if ((cmt as NoteComment).id === comment.id) {
					cmt.mode = CommentMode.Editing;
				}

				return cmt;
			});
			this.writeThreads()
		})
		this.commands.push(editNote);
		this.context.subscriptions.push(editNote);

		let dispose = commands.registerCommand('textfile_comments.dispose', () => {
			this.commentController.dispose();
		})
		this.commands.push(dispose);
		this.context.subscriptions.push(dispose);
	}

	replyNote(reply: CommentReply) {
		const thread = reply.thread;
		const newComment = new NoteComment(reply.text, CommentMode.Preview, { name: this.author }, thread, thread.comments.length ? 'canDelete' : undefined);
		if (thread.contextValue === 'draft') {
			newComment.label = 'pending';
		}

		thread.comments = [...thread.comments, newComment];
		this.saveThread(thread)
	}

	readThreads() {
		if (fs.existsSync(this.filePath)) {
			const threads = require(this.filePath.toString())
			for (const thread of threads) {
				const new_thread = this.commentController.createCommentThread(
					thread.uri,
					new Range(thread.range[0], thread.range[1]),
					thread.comments.map((comment: any) => {
						return NoteComment.fromJSON(comment)
					})
				)
				new_thread.comments.forEach((comment:Comment) => {
					(comment as NoteComment).parent = new_thread
				})
				this.threads.add(new_thread)
			}
		}
	}

	writeThreads() {
		console.log("Saving all threads to file")
		console.log(this.filePath)
		let threads = []
		for (let thread of this.threads) {
			threads.push({
				uri: thread.uri,
				range: thread.range,
				comments: thread.comments
			})
		}
		const data = JSON.stringify(threads)
		console.log(data)
		fs.writeFileSync(this.filePath, data)
	}

	saveThread(thread: CommentThread) {
		this.threads.add(thread)
		this.writeThreads()
	}

	deleteThread(thread: CommentThread) {
		this.threads.delete(thread)
		thread.dispose()
		this.writeThreads()
	}

	/**
	 * dispose all current registrations and update the subscriptions
	 */
	unregisterCommands() {
		this.commands.forEach(command => {
			command.dispose();
		})
	}

	refreshCommands() {
		this.unregisterCommands();
		this.registerCommands();
	}

}

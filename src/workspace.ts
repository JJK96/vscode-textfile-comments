import {
	commands,
	workspace,
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
	WorkspaceConfiguration,
	FileSystemWatcher,
	CommentController,
	window,
} from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { time } from 'console';
import { log } from './extension';

let commentId = 1;
const default_author = "Unknown"
const default_label = "open"

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
			label: this.label,
		}
	}

	static fromJSON(comment: any) {
		const newComment = new NoteComment(
			comment.body,
			comment.mode,
			comment.author,
			undefined,
			comment.contextValue
		)
		newComment.label = comment.label
		return newComment
	}
}


export class WorkspaceContext {
	private commentController: CommentController;
	private commands: Disposable[] = [];
	private threads = new Map<String, CommentThread>();
	private fileWatcher: FileSystemWatcher;

	constructor(private context: ExtensionContext, public workspaceRoot: string) {
		this.commentController = this.initCommentController()

		this.fileWatcher = this.initFileWatcher()

		this.readThreads();
	}
	get filePath(): fs.PathLike {
		return path.join(this.workspaceRoot, this.config.get('filename')!)
	}

	get config(): WorkspaceConfiguration {
		return workspace.getConfiguration("textfile_comments")
	}

	get author(): string {
		const res:string = this.config.get('author')!
		if (res == "Author") {
			window.showErrorMessage("Please set the author setting to your name so it appears on your comments")
		}
		return res
	}

	initCommentController() {
		// A `CommentController` is able to provide comments for documents.
		this.commentController = comments.createCommentController('textfile_comments', 'Textfile Comments');
		this.context.subscriptions.push(this.commentController);

		// A `CommentingRangeProvider` controls where gutter decorations that allow adding comments are shown
		this.commentController.commentingRangeProvider = {
			provideCommentingRanges: (document: TextDocument, token: CancellationToken) => {
				const lineCount = document.lineCount;
				return [new Range(0, 0, lineCount - 1, 0)];
			}
		};

		return this.commentController;
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
			const thread = reply.thread
			if (thread) {
				thread.contextValue = default_label
			}
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

			thread.contextValue = default_label;
			thread.collapsibleState = CommentThreadCollapsibleState.Collapsed;
			if (reply.text) {
				const newComment = new NoteComment(reply.text, CommentMode.Preview, { name: this.author }, thread);
				thread.comments = [...thread.comments, newComment]
			}
			thread.comments = thread.comments.map(comment => {
				comment.label = default_label;
				return comment;
			});
			this.saveThread(reply.thread);
		})
		this.commands.push(finishDraft);
		this.context.subscriptions.push(finishDraft);

		let resolve = commands.registerCommand('textfile_comments.resolve', (reply: CommentReply) => {
			this.updateLabel(reply.thread, "resolved")
		})
		this.commands.push(resolve);
		this.context.subscriptions.push(resolve);

		let unresolve = commands.registerCommand('textfile_comments.unresolve', (reply: CommentReply) => {
			this.updateLabel(reply.thread, default_label)
		})
		this.commands.push(unresolve);
		this.context.subscriptions.push(unresolve);

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
		} else {
			newComment.label = default_label;
		}

		thread.comments = [...thread.comments, newComment];
		this.saveThread(thread)
	}

	refresh() {
		log.appendLine("Refreshing")
		for (const thread of this.threads.values()) {
			thread.dispose();
		}
		this.readThreads();
	}

	readThreads() {
		log.appendLine("Reading")
		log.appendLine("Resetting this.threads")
		this.threads = new Map<String, CommentThread>();
		if (fs.existsSync(this.filePath)) {
			const bufferData = fs.readFileSync(this.filePath)
			const threads= JSON.parse(bufferData.toString())
			for (const thread of threads) {
				const start = thread.range[0]
				const end = thread.range[1] 
				const new_thread = this.commentController.createCommentThread(
					thread.uri,
					new Range(start.line, start.character, end.line, end.character),
					thread.comments.map((comment: any) => {
						return NoteComment.fromJSON(comment)
					})
				)
				new_thread.comments.forEach((comment: Comment) => {
					(comment as NoteComment).parent = new_thread
				})
				new_thread.contextValue = thread.contextValue
				this.threads.set(new_thread.uri.toString(), new_thread)
			}
		}
	}

	updateLabel(thread: CommentThread, label: string) {
		if (!thread) {
			return;
		}
		thread.contextValue = label
		thread.comments = thread.comments.map(comment => {
			comment.label = label;
			return comment;
		});
		this.writeThreads();
	}

	writeThreads() {
		log.appendLine("Writing threads")
		log.appendLine("Threads size: " + this.threads.size)
		let threads = []
		for (let thread of this.threads.values()) {
			threads.push({
				uri: thread.uri,
				range: thread.range,
				contextValue: thread.contextValue,
				comments: thread.comments
			})
		}
		const data = JSON.stringify(threads)
		// Pause watching for file changes because we are going to cause one
		this.stopWatchingForFileChanges()
		fs.writeFileSync(this.filePath, data)
		// Otherwise the event is still triggered
		setTimeout(() => {
			this.initFileWatcher()
		}, 100)
	}

	saveThread(thread: CommentThread) {
		this.threads.set(thread.uri.toString(), thread)
		this.writeThreads()
	}

	deleteThread(thread: CommentThread) {
		this.threads.delete(thread.uri.toString())
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

	initFileWatcher() {
		this.fileWatcher = workspace.createFileSystemWatcher(`**/${this.filePath}`);	
		this.watchForFileChanges();
		return this.fileWatcher
	}

	/**
	 * watch on the comments file for changes
	 */
	watchForFileChanges() {
		// refresh comment view on manual changes in the comments file
		this.fileWatcher.onDidChange(() => {
			log.appendLine("File changed")
			this.refresh();
		});
		this.fileWatcher.onDidCreate(() => {
			this.refresh();
		});
		this.fileWatcher.onDidDelete(() => {
			log.appendLine("Deleted file")
			this.refresh();
		});
	}

	stopWatchingForFileChanges() {
		this.fileWatcher.dispose()
	}


}

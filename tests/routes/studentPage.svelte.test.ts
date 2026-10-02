import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { toast } from "svelte-sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_WORDS } from "../../convex/lib/constants.js";
import { downloadBlob } from "../../src/lib/download.js";
import { session } from "../../src/lib/session.svelte.js";
import type { ChatMessage } from "../../src/lib/types.js";
import StudentPage from "../../src/routes/(app)/student/+page.svelte";
import { makeContact } from "../support/fixtures.js";

const mockQuery = vi.fn();

// A stand-in for the run store whose fields the page reads reactively.
class FakeRun {
	loadError = $state("");
	timeExpired = $state(false);
	isSending = $state(false);
	activeContactId = $state<string | null>("mary");
	notes = $state("");
	caseData = $state<{
		case_name: string;
		brief: string;
	} | null>({ case_name: "Sterling Industries", brief: "Reduce costs." });
	totalDurationSeconds = $state<number | null>(null);
	streamingPreview = $state<string | null>(null);
	pendingMessage = $state<string | null>(null);
	activeMessages = $state<ChatMessage[]>([]);
	contacts = $state<ReturnType<typeof makeDisplayContact>[]>([]);
	sharedFiles = $state<{ file_id: string; file_name: string; url: string }[]>(
		[],
	);
	activePersonaAvailable = $state(true);

	get activeContact() {
		return this.contacts.find((c) => c.id === this.activeContactId) ?? null;
	}

	init = vi.fn();
	destroy = vi.fn();
	selectContact = vi.fn((id: string) => {
		this.activeContactId = id;
	});
	sendMessage = vi.fn((_message: string) => true);
	setNotes = vi.fn((value: string) => {
		this.notes = value;
	});
	flushNotes = vi.fn();
	endSimulation = vi.fn();
}

let run: FakeRun;

// Builds a contact as the page receives it, with availability already worked out.
function makeDisplayContact(
	overrides: Partial<ReturnType<typeof makeContact>> & {
		available?: boolean;
		available_in?: number | null;
		expires_in?: number | null;
	} = {},
) {
	return {
		...makeContact(),
		available: true,
		available_in: null,
		expires_in: null,
		...overrides,
	};
}

vi.mock("convex-svelte", () => ({
	getConvexClient: () => ({ query: mockQuery }),
}));

vi.mock("../../src/lib/student/run.svelte.js", () => ({
	createRunStore: () => run,
	exportRunRef: { name: "exportRun" },
}));

vi.mock("../../src/lib/download.js", () => ({ downloadBlob: vi.fn() }));

beforeEach(() => {
	run = new FakeRun();
	run.contacts = [
		makeDisplayContact({ id: "mary", name: "Mary Chen", role: "CFO" }),
		makeDisplayContact({
			id: "bob",
			name: "Bob Ray",
			role: "Analyst",
			available: false,
			available_in: 5,
		}),
	];
	mockQuery.mockReset();
	vi.mocked(downloadBlob).mockReset();
	session.startRun({ runId: "run-1" });
	Element.prototype.scrollIntoView = vi.fn();
});

describe("student page lifecycle", () => {
	// Tests that the run store is initialised on mount and destroyed on unmount.
	it("initialises the run on mount and destroys it on unmount", () => {
		const { unmount } = render(StudentPage);
		expect(run.init).toHaveBeenCalledOnce();
		unmount();
		expect(run.destroy).toHaveBeenCalledOnce();
	});

	// Tests that the case name and brief show once loaded, with placeholders before.
	it("shows the case name and brief, or placeholders while loading", () => {
		const loaded = render(StudentPage);
		expect(screen.getByText("Sterling Industries")).toBeInTheDocument();
		expect(screen.getByText("Reduce costs.")).toBeInTheDocument();
		loaded.unmount();

		run = new FakeRun();
		run.caseData = null;
		render(StudentPage);
		expect(screen.getByText("Loading case…")).toBeInTheDocument();
		expect(screen.getByText("Loading brief...")).toBeInTheDocument();
	});

	// Tests that a load failure is announced.
	it("shows a load error as an alert", () => {
		run.loadError = "Failed to load the simulation.";
		render(StudentPage);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Failed to load the simulation.",
		);
	});
});

describe("contacts and files", () => {
	// Tests that unavailable contacts are disabled and say when they arrive.
	it("disables an unavailable contact and shows when they will be available", () => {
		render(StudentPage);
		expect(screen.getByRole("button", { name: /Mary Chen/ })).toBeEnabled();
		const bob = screen.getByRole("button", { name: /Bob Ray/ });
		expect(bob).toBeDisabled();
		expect(bob).toHaveTextContent("Available in 5 min");
	});

	// Tests that clicking an available contact selects them.
	it("selects a contact when clicked", async () => {
		run.contacts.push(makeDisplayContact({ id: "zed", name: "Zed Ito" }));
		const user = userEvent.setup();
		render(StudentPage);
		await user.click(screen.getByRole("button", { name: /Zed Ito/ }));
		expect(run.selectContact).toHaveBeenCalledWith("zed");
	});

	// Tests that the contact card badges reflect availability windows and referral state.
	it("shows expiry, ended and referred badges", () => {
		run.contacts = [
			makeDisplayContact({
				id: "mary",
				availability_duration: 20,
				expires_in: 4,
				chat_ended: true,
				is_referred: true,
			}),
		];
		render(StudentPage);
		const card = screen.getByRole("button", { name: /Mary|Persona/ });
		expect(card).toHaveTextContent("Available for 20 min");
		expect(card).toHaveTextContent("Expires in 4 min");
		expect(card).toHaveTextContent("Conversation ended");
		expect(card).toHaveTextContent("Referred contact");
	});

	// Tests that shared files are linked, or a placeholder is shown when there are none.
	it("lists shared files as links, with a placeholder when there are none", () => {
		const empty = render(StudentPage);
		expect(screen.getByText("No shared files yet.")).toBeInTheDocument();
		empty.unmount();

		run = new FakeRun();
		run.contacts = [makeDisplayContact({ id: "mary" })];
		run.sharedFiles = [
			{
				file_id: "f1",
				file_name: "budget.pdf",
				url: "https://x.test/budget.pdf",
			},
		];
		render(StudentPage);
		expect(screen.getByRole("link", { name: "budget.pdf" })).toHaveAttribute(
			"href",
			"https://x.test/budget.pdf",
		);
	});
});

describe("chat pane", () => {
	// Tests that an empty history shows the empty placeholder.
	it("shows an empty-history message", () => {
		render(StudentPage);
		expect(screen.getByText("Chat history is empty.")).toBeInTheDocument();
	});

	// Tests that messages and the in-flight reply are rendered in order.
	it("renders the history and the streaming reply", () => {
		run.activeMessages = [
			{ role: "user", content: "Hi Mary" },
			{ role: "assistant", content: "Hello." },
		];
		run.streamingPreview = "Typing a rep";
		render(StudentPage);
		expect(screen.getByText("Hi Mary")).toBeInTheDocument();
		expect(screen.getByText("Hello.")).toBeInTheDocument();
		expect(screen.getByText("Typing a rep")).toBeInTheDocument();
	});

	// Tests that the student's unsaved message shows in an empty chat before the reply.
	it("shows the student's pending message before the reply has been saved", () => {
		run.pendingMessage = "What vendor do we use?";
		render(StudentPage);
		expect(screen.getByText("What vendor do we use?")).toBeInTheDocument();
		expect(
			screen.queryByText("Chat history is empty."),
		).not.toBeInTheDocument();
	});

	// Tests that an ended conversation is explained and the composer is locked.
	it("explains an ended conversation and disables the composer", () => {
		run.contacts = [makeDisplayContact({ id: "mary", chat_ended: true })];
		run.activePersonaAvailable = false;
		render(StudentPage);
		expect(
			screen.getByText(
				"This persona has ended the conversation for this chat.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByPlaceholderText("This conversation has ended."),
		).toBeDisabled();
	});

	// Tests that once time is up the banner shows and messaging is disabled.
	it("shows the time's-up banner and disables messaging", () => {
		run.timeExpired = true;
		run.activePersonaAvailable = false;
		render(StudentPage);
		expect(screen.getByText(/Your time is up/)).toBeInTheDocument();
		expect(
			screen.getByPlaceholderText("Time's up — messaging is disabled."),
		).toBeDisabled();
	});
});

describe("composer", () => {
	// Tests that the send button stays off until there is something to send.
	it("disables Send for an empty message", () => {
		render(StudentPage);
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	// Tests that the button sends the message and clears the box when accepted.
	it("sends the typed message and clears the box", async () => {
		const user = userEvent.setup();
		render(StudentPage);
		const box = screen.getByPlaceholderText("Type your message...");
		await user.type(box, "What is the budget?");
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(run.sendMessage).toHaveBeenCalledWith("What is the budget?");
		expect(box).toHaveValue("");
	});

	// Tests that Enter sends but Shift+Enter adds a line.
	it("sends on Enter and keeps the text on Shift+Enter", async () => {
		const user = userEvent.setup();
		render(StudentPage);
		const box = screen.getByPlaceholderText("Type your message...");
		await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
		expect(run.sendMessage).not.toHaveBeenCalled();
		expect(box).toHaveValue("line one\nline two");
		await user.type(box, "{Enter}");
		expect(run.sendMessage).toHaveBeenCalledWith("line one\nline two");
	});

	// Tests that a rejected send keeps what the student typed.
	it("keeps the text when the store declines the message", async () => {
		run.sendMessage.mockReturnValue(false);
		const user = userEvent.setup();
		render(StudentPage);
		const box = screen.getByPlaceholderText("Type your message...");
		await user.type(box, "hello{Enter}");
		expect(box).toHaveValue("hello");
	});

	// Tests that over-long messages are blocked and the counter warns.
	it("blocks a message over the word limit", async () => {
		const user = userEvent.setup();
		render(StudentPage);
		const box = screen.getByPlaceholderText("Type your message...");
		await user.click(box);
		await user.paste(
			Array(MAX_MESSAGE_WORDS + 1)
				.fill("w")
				.join(" "),
		);
		expect(
			screen.getByText(`${MAX_MESSAGE_WORDS + 1}/${MAX_MESSAGE_WORDS} words`),
		).toHaveClass("text-brand");
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		await user.type(box, "{Enter}");
		expect(run.sendMessage).not.toHaveBeenCalled();
	});

	// Tests that the composer is locked while a reply is being generated.
	it("disables the box and shows typing dots while sending", () => {
		run.isSending = true;
		render(StudentPage);
		expect(screen.getByPlaceholderText("Type your message...")).toBeDisabled();
		expect(screen.getByLabelText("Typing")).toBeInTheDocument();
	});
});

describe("notes and ending", () => {
	// Tests that typing notes goes to the store and leaving the box flushes them.
	it("passes notes to the store and flushes on blur", async () => {
		run.activePersonaAvailable = false;
		const user = userEvent.setup();
		render(StudentPage);
		const notes = screen.getByPlaceholderText("Write your notes here...");
		await user.type(notes, "key fact");
		expect(run.setNotes).toHaveBeenLastCalledWith("key fact");
		await user.tab();
		expect(run.flushNotes).toHaveBeenCalled();
	});

	// Tests that the end button ends the simulation.
	it("ends the simulation from the button", async () => {
		const user = userEvent.setup();
		render(StudentPage);
		await user.click(screen.getByRole("button", { name: "End simulation" }));
		expect(run.endSimulation).toHaveBeenCalledOnce();
	});
});

describe("PDF export", () => {
	// Tests that the export fetches the run and downloads a PDF named chats.pdf.
	it("builds and downloads the transcript", async () => {
		mockQuery.mockResolvedValue({
			personas: [
				{
					id: "mary",
					name: "Mary Chen",
					role: "CFO",
					messages: [{ role: "user", content: "Hi" }],
				},
			],
		});
		run.notes = "my notes";
		const user = userEvent.setup();
		render(StudentPage);
		await user.click(screen.getByRole("button", { name: "Export PDF" }));
		await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
		expect(mockQuery).toHaveBeenCalledWith(expect.anything(), {
			runId: "run-1",
		});
		const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0] as [
			Blob,
			string,
		];
		expect(filename).toBe("chats.pdf");
		expect(blob.type).toBe("application/pdf");
		expect(screen.getByRole("button", { name: "Export PDF" })).toBeEnabled();
	});

	// Tests that a run with no personas still exports.
	it("exports when the run has no personas", async () => {
		mockQuery.mockResolvedValue({});
		const user = userEvent.setup();
		render(StudentPage);
		await user.click(screen.getByRole("button", { name: "Export PDF" }));
		await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
	});

	// Tests that a failed export toasts and leaves the button usable again.
	it("toasts and re-enables the button when the export fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockQuery.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(StudentPage);
		await user.click(screen.getByRole("button", { name: "Export PDF" }));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				"Unable to export PDF. Please try again.",
			),
		);
		expect(downloadBlob).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Export PDF" })).toBeEnabled();
	});

	// Tests that export is unavailable without a run.
	it("disables export when there is no run", () => {
		session.clearRun();
		render(StudentPage);
		expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
	});

	// Tests that a second click while exporting does not start another export.
	it("ignores a second click while an export is running", async () => {
		let finish: (value: unknown) => void = () => {};
		mockQuery.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const user = userEvent.setup();
		render(StudentPage);
		await user.click(screen.getByRole("button", { name: "Export PDF" }));
		expect(
			await screen.findByRole("button", { name: "Exporting…" }),
		).toBeDisabled();
		finish({ personas: [] });
		await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
		expect(mockQuery).toHaveBeenCalledOnce();
	});
});

import type { FunctionReturnType } from "convex/server";
import { toast } from "svelte-sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { api } from "#convex/api.js";
import type { Id } from "#convex/dataModel.js";
import { MAX_MESSAGE_WORDS } from "#shared/rules.js";
import { downloadBlob } from "../../src/lib/download.js";
import { session } from "../../src/lib/session.svelte.js";
import type { RunStore } from "../../src/lib/student/run.svelte.js";
import type { ChatMessage } from "../../src/lib/types.js";
import StudentPage from "../../src/routes/(app)/student/+page.svelte";
import { convexFake } from "../support/convexFake.svelte.js";
import { makeContact, makeSharedFile } from "../support/factories.js";

const exportRun = convexFake.clientQuery(api.runs.exportRun);

// Builds the export result the page turns into a PDF.
const exportOf = (
	personas: FunctionReturnType<typeof api.runs.exportRun>["personas"],
) => ({
	case: { id: "case-1" as Id<"cases">, name: "Sterling Industries" },
	personas,
});

// The run-store members the student page uses; the fake below must keep providing them.
type PageRunStore = Pick<
	RunStore,
	| "loadError"
	| "timeExpired"
	| "isSending"
	| "activeContactId"
	| "notes"
	| "caseData"
	| "totalDurationSeconds"
	| "activeMessages"
	| "contacts"
	| "sharedFiles"
	| "activePersonaAvailable"
	| "failedMessage"
	| "activeContact"
	| "init"
	| "selectContact"
	| "sendMessage"
	| "setNotes"
	| "endSimulation"
>;

// A stand-in for the run store whose fields the page reads reactively.
class FakeRun implements PageRunStore {
	loadError = $state("");
	timeExpired = $state(false);
	isSending = $state(false);
	activeContactId = $state<string | null>("mary");
	notes = $state("");
	caseData = $state<RunStore["caseData"]>({
		id: "case-1" as Id<"cases">,
		name: "Sterling Industries",
		brief: "Reduce costs.",
		duration: null,
		authors: [
			{ name: "Olive Owner", email: "olive@example.com" },
			{ name: "Edith Editor", email: "edith@example.com" },
		],
	});
	totalDurationSeconds = $state<number | null>(null);
	activeMessages = $state<ChatMessage[]>([]);
	contacts = $state<RunStore["contacts"]>([]);
	sharedFiles = $state<RunStore["sharedFiles"]>([]);
	activePersonaAvailable = $state(true);
	failedMessage = $state<string | null>(null);

	get activeContact() {
		return this.contacts.find((c) => c.id === this.activeContactId) ?? null;
	}

	init = vi.fn();
	selectContact = vi.fn((id: string) => {
		this.activeContactId = id;
	});
	sendMessage = vi.fn(async (_message: string) => true);
	setNotes = vi.fn((value: string) => {
		this.notes = value;
	});
	endSimulation = vi.fn();
}

let run: FakeRun;

// Builds a contact as the page receives it, with availability already worked out.
function makeDisplayContact(
	overrides: Partial<ReturnType<typeof makeContact>> & {
		available?: boolean;
		expiresIn?: number | null;
	} = {},
) {
	return {
		...makeContact(),
		available: true,
		expiresIn: null,
		...overrides,
	};
}

vi.mock("../../src/lib/student/run.svelte.js", () => ({
	createRunStore: () => run,
}));

vi.mock("../../src/lib/download.js", () => ({ downloadBlob: vi.fn() }));

const messageBox = () => page.getByPlaceholder("Type your message...");
const sendButton = () => page.getByRole("button", { name: "Send" });
const exportButton = () => page.getByRole("button", { name: "Export PDF" });

// The page's own scroll calls, watched but left to run.
let scrollTo: ReturnType<typeof vi.spyOn>;
let scrollIntoView: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	run = new FakeRun();
	run.contacts = [
		makeDisplayContact({ id: "mary", name: "Mary Chen", role: "CFO" }),
	];
	vi.mocked(downloadBlob).mockReset();
	session.startRun({ runId: "run-1", startTime: Date.now() });
	scrollTo = vi.spyOn(Element.prototype, "scrollTo");
	scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("student page lifecycle", () => {
	// Tests that the run store is initialised on mount.
	it("initialises the run on mount", async () => {
		await render(StudentPage);
		expect(run.init).toHaveBeenCalledOnce();
	});

	// Tests that the case name and brief show once loaded, with placeholders before.
	it("shows the case name and brief, or placeholders while loading", async () => {
		const loaded = await render(StudentPage);
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();
		await expect.element(page.getByText("Reduce costs.")).toBeVisible();
		loaded.unmount();

		run = new FakeRun();
		run.caseData = null;
		await render(StudentPage);
		await expect.element(page.getByText("Loading case…")).toBeVisible();
		await expect.element(page.getByText("Loading brief...")).toBeVisible();
	});

	// Tests that a load failure is announced.
	it("shows a load error as an alert", async () => {
		run.loadError = "Failed to load the simulation.";
		await render(StudentPage);
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("Failed to load the simulation.");
	});
});

describe("contacts and files", () => {
	// Tests that clicking an available contact selects them.
	it("selects a contact when clicked", async () => {
		run.contacts.push(makeDisplayContact({ id: "zed", name: "Zed Ito" }));
		await render(StudentPage);
		await page.getByRole("button", { name: /Zed Ito/ }).click();
		expect(run.selectContact).toHaveBeenCalledWith("zed");
	});

	// Tests that a contact whose window has closed can still be opened to review the chat.
	it("lets the student open an expired contact and says it is unavailable", async () => {
		run.contacts = [
			makeDisplayContact({
				id: "mary",
				name: "Mary Chen",
				available: false,
				expiresIn: 0,
			}),
		];
		run.activePersonaAvailable = false;
		await render(StudentPage);

		await page.getByRole("button", { name: /Mary Chen/ }).click();

		expect(run.selectContact).toHaveBeenCalledWith("mary");
		await expect
			.element(page.getByText("Available", { exact: true }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByPlaceholder("This contact is no longer available."))
			.toBeDisabled();
	});

	// Tests that the contact card badges reflect availability windows and referral state.
	it("shows expiry, ended and referred badges", async () => {
		run.contacts = [
			makeDisplayContact({
				id: "mary",
				availabilityDuration: 20,
				expiresIn: 4,
				chatEnded: true,
				isReferred: true,
			}),
		];
		await render(StudentPage);
		const card = page.getByRole("button", { name: /Mary|Persona/ });
		await expect.element(card.getByText("Available for 20 min")).toBeVisible();
		await expect.element(card.getByText("Expires in 4 min")).toBeVisible();
		await expect.element(card.getByText("Conversation ended")).toBeVisible();
		await expect.element(card.getByText("Referred contact")).toBeVisible();
	});

	// Tests that shared files are linked, or a placeholder is shown when there are none.
	it("lists shared files as links, with a placeholder when there are none", async () => {
		const empty = await render(StudentPage);
		await expect.element(page.getByText("No shared files yet.")).toBeVisible();
		empty.unmount();

		run = new FakeRun();
		run.contacts = [makeDisplayContact({ id: "mary" })];
		run.sharedFiles = [
			makeSharedFile({
				fileId: "f1",
				fileName: "budget.pdf",
				url: "https://x.test/budget.pdf",
			}),
		];
		await render(StudentPage);
		await expect
			.element(page.getByRole("link", { name: "budget.pdf" }))
			.toHaveAttribute("href", "https://x.test/budget.pdf");
	});
});

describe("chat pane", () => {
	// Tests that an empty history shows the empty placeholder.
	it("shows an empty-history message", async () => {
		await render(StudentPage);
		await expect
			.element(page.getByText("Chat history is empty."))
			.toBeVisible();
	});

	// Tests that messages are rendered in order.
	it("renders the history in order", async () => {
		run.activeMessages = [
			{ role: "user", content: "Hi Mary" },
			{ role: "assistant", content: "Hello." },
		];
		await render(StudentPage);
		await expect.element(page.getByText("Hi Mary")).toBeVisible();
		await expect.element(page.getByText("Hello.")).toBeVisible();
		const [first, second] = [
			page.getByText("Hi Mary").element(),
			page.getByText("Hello.").element(),
		];
		expect(
			first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	// Tests that a new message scrolls only the chat box, never the page, which jumps on narrow screens.
	it("scrolls the chat box to the newest message without scrolling the page", async () => {
		run.activeMessages = [{ role: "user", content: "Hi Mary" }];
		await render(StudentPage);

		await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled());
		// The element scrolled is the chat box, which holds the conversation log.
		const [scrolled] = scrollTo.mock.contexts as Element[];
		expect(scrolled?.contains(page.getByRole("log").element())).toBe(true);
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	// Tests that the student's message shows in an otherwise empty chat while its reply is pending.
	it("shows the student's message while its reply is pending", async () => {
		run.activeMessages = [{ role: "user", content: "What vendor do we use?" }];
		run.isSending = true;
		await render(StudentPage);
		await expect
			.element(page.getByText("What vendor do we use?"))
			.toBeVisible();
		await expect
			.element(page.getByText("Chat history is empty."))
			.not.toBeInTheDocument();
	});

	// Tests that an ended conversation is explained and the composer is locked.
	it("explains an ended conversation and disables the composer", async () => {
		run.contacts = [makeDisplayContact({ id: "mary", chatEnded: true })];
		run.activePersonaAvailable = false;
		await render(StudentPage);
		await expect
			.element(
				page.getByText(
					"This persona has ended the conversation for this chat.",
				),
			)
			.toBeVisible();
		await expect
			.element(page.getByPlaceholder("This conversation has ended."))
			.toBeDisabled();
	});

	// Tests that once time is up the banner shows and messaging is disabled.
	it("shows the time's-up banner and disables messaging", async () => {
		run.timeExpired = true;
		run.activePersonaAvailable = false;
		await render(StudentPage);
		await expect.element(page.getByText(/Your time is up/)).toBeVisible();
		await expect
			.element(page.getByPlaceholder("Time's up — messaging is disabled."))
			.toBeDisabled();
	});
});

describe("composer", () => {
	// Tests that the send button stays off until there is something to send.
	it("disables Send for an empty message", async () => {
		await render(StudentPage);
		await expect.element(sendButton()).toBeDisabled();
	});

	// Tests that the button sends the message and clears the box when accepted.
	it("sends the typed message and clears the box", async () => {
		await render(StudentPage);
		await messageBox().fill("What is the budget?");
		await sendButton().click();
		expect(run.sendMessage).toHaveBeenCalledWith("What is the budget?");
		await expect.element(messageBox()).toHaveValue("");
	});

	// Tests that Enter sends but Shift+Enter adds a line.
	it("sends on Enter and keeps the text on Shift+Enter", async () => {
		await render(StudentPage);
		await messageBox().fill("line one");
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}line two");
		expect(run.sendMessage).not.toHaveBeenCalled();
		await expect.element(messageBox()).toHaveValue("line one\nline two");
		await userEvent.keyboard("{Enter}");
		expect(run.sendMessage).toHaveBeenCalledWith("line one\nline two");
	});

	// Tests that Enter pressed while an IME composition is active does not send the message.
	it("does not send on Enter during IME composition", async () => {
		await render(StudentPage);
		await page.getByLabelText("Message").fill("ni");
		page
			.getByLabelText("Message")
			.element()
			.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					isComposing: true,
					bubbles: true,
				}),
			);
		expect(run.sendMessage).not.toHaveBeenCalled();
	});

	// Tests that a rejected send keeps what the student typed.
	it("keeps the text when the store declines the message", async () => {
		run.sendMessage.mockResolvedValue(false);
		await render(StudentPage);
		await messageBox().fill("hello");
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() => expect(run.sendMessage).toHaveBeenCalled());
		await expect.element(messageBox()).toHaveValue("hello");
	});

	// Tests that a failed reply shows a banner that puts the message back in the box, ahead of anything typed since.
	it("offers to put a failed message back in the box", async () => {
		run.failedMessage = "What is the budget?";
		await render(StudentPage);
		await expect
			.element(page.getByRole("alert").getByText(/What is the budget\?/))
			.toBeVisible();

		await messageBox().fill("Also the timeline.");
		const restore = page.getByRole("button", {
			name: "Put it back in the box",
		});
		await restore.click();
		await expect
			.element(messageBox())
			.toHaveValue("What is the budget?\nAlso the timeline.");

		await restore.click();
		await expect
			.element(messageBox())
			.toHaveValue("What is the budget?\nAlso the timeline.");
	});

	// Tests that there is no banner while nothing has failed.
	it("shows no failure banner when nothing failed", async () => {
		await render(StudentPage);
		await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
	});

	// Tests that over-long messages are blocked and the counter warns.
	it("blocks a message over the word limit", async () => {
		await render(StudentPage);
		await messageBox().fill(
			Array(MAX_MESSAGE_WORDS + 1)
				.fill("w")
				.join(" "),
		);
		await expect
			.element(
				page.getByText(`${MAX_MESSAGE_WORDS + 1}/${MAX_MESSAGE_WORDS} words`),
			)
			.toHaveClass("text-brand");
		await expect.element(sendButton()).toBeDisabled();
		await userEvent.keyboard("{Enter}");
		expect(run.sendMessage).not.toHaveBeenCalled();
	});

	// Tests that the composer is locked while a reply is being generated.
	it("disables the box and shows the sending ring while sending", async () => {
		run.isSending = true;
		await render(StudentPage);
		await expect.element(messageBox()).toBeDisabled();
		await expect.element(page.getByLabelText("Sending")).toBeVisible();
	});
});

describe("notes and ending", () => {
	// Tests that typing notes goes to the store.
	it("passes notes to the store", async () => {
		run.activePersonaAvailable = false;
		await render(StudentPage);
		await page.getByPlaceholder("Write your notes here...").fill("key fact");
		expect(run.setNotes).toHaveBeenLastCalledWith("key fact");
	});

	// Tests that the end button ends the simulation.
	it("ends the simulation from the button", async () => {
		await render(StudentPage);
		await page.getByRole("button", { name: "End simulation" }).click();
		expect(run.endSimulation).toHaveBeenCalledOnce();
	});
});

describe("authors", () => {
	// Tests that the header shows each author's name beside the case name.
	it("lists the authors beside the case name", async () => {
		await render(StudentPage);
		const line = page.elementLocator(
			page.getByText("Sterling Industries").element().parentElement!,
		);
		await expect.element(line.getByText("Olive Owner")).toBeVisible();
		await expect.element(line.getByText("Edith Editor")).toBeVisible();
	});

	// Tests that hovering an author's name shows that author's own email.
	it("shows an author's email on hover", async () => {
		await render(StudentPage);
		await page.getByText("Edith Editor").hover();
		await expect
			.element(page.getByText("edith@example.com").first())
			.toBeVisible();
		await expect
			.element(page.getByText("olive@example.com"))
			.not.toBeInTheDocument();
	});

	// Tests that only the case name is shown when the case has no authors to credit.
	it("shows no authors when there are none", async () => {
		run.caseData = { ...run.caseData!, authors: [] };
		await render(StudentPage);
		await expect.element(page.getByText("Sterling Industries")).toBeVisible();
		await expect.element(page.getByText("Olive Owner")).not.toBeInTheDocument();
	});

	// Tests that the old floating Authors and Contact buttons are gone.
	it("no longer shows the Authors and Contact buttons", async () => {
		await render(StudentPage);
		await expect
			.element(page.getByRole("button", { name: "Authors" }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByRole("button", { name: "Contact" }))
			.not.toBeInTheDocument();
	});
});

describe("PDF export", () => {
	// Tests that the export fetches the run and downloads a PDF named chats.pdf.
	it("builds and downloads the transcript", async () => {
		exportRun.mockResolvedValue(
			exportOf([
				{
					id: "mary",
					name: "Mary Chen",
					role: "CFO",
					messages: [{ role: "user", content: "Hi" }],
				},
			]),
		);
		run.notes = "my notes";
		await render(StudentPage);
		await exportButton().click();
		await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
		expect(exportRun).toHaveBeenCalledWith({ runId: "run-1" });
		const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0] as [
			Blob,
			string,
		];
		expect(filename).toBe("chats.pdf");
		expect(blob.type).toBe("application/pdf");
		await expect.element(exportButton()).toBeEnabled();
	});

	// Tests that a run with no personas still exports.
	it("exports when the run has no personas", async () => {
		exportRun.mockResolvedValue(exportOf([]));
		await render(StudentPage);
		await exportButton().click();
		await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
	});

	// Tests that a failed export toasts and leaves the button usable again.
	it("toasts and re-enables the button when the export fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		exportRun.mockRejectedValue(new Error("boom"));
		await render(StudentPage);
		await exportButton().click();
		await vi.waitFor(() =>
			expect(toast).toHaveBeenCalledWith(
				"Unable to export PDF. Please try again.",
			),
		);
		expect(downloadBlob).not.toHaveBeenCalled();
		await expect.element(exportButton()).toBeEnabled();
	});

	// Tests that export is unavailable without a run.
	it("disables export when there is no run", async () => {
		session.clearRun();
		await render(StudentPage);
		await expect.element(exportButton()).toBeDisabled();
	});

	// Tests that a second click while exporting does not start another export.
	it("ignores a second click while an export is running", async () => {
		let finish: (value: ReturnType<typeof exportOf>) => void = () => {};
		exportRun.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		await render(StudentPage);
		await exportButton().click();
		await expect
			.element(page.getByRole("button", { name: "Exporting…" }))
			.toBeDisabled();
		finish(exportOf([]));
		await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
		expect(exportRun).toHaveBeenCalledOnce();
	});
});

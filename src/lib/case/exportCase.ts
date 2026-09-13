// Exports an empty case form so admins can autofill it with AI

import { downloadBlob } from "../download.js";
import type { Persona, ReferralEdge } from "../types.js";
import {
	createEmptyPersona,
	createEmptyReferral,
	reachableFrom,
} from "./draft.js";

// Escapes quotes too, not just `&`/`<`/`>` -- every call site below that used to embed this
// unescaped landed a value straight inside a double-quoted HTML attribute (persona ids in
// data-persona-id and an <option>'s value), so a value containing `"` could close that
// attribute early and inject markup of its own into whichever admin's browser opens the
// exported file. See PERSONA_ID_FORMAT's own comment (services/cases.ts) for why a persona id
// is the concrete way an id like that reaches here: this escaping is the second, independent
// line of defense for an id already stored under that format's older, wider charset.
const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

// Embedded verbatim (via .toString()) into the generated <script> below, so the exported
// form's own persona-removal cascade runs graph.svelte.ts's exact reachability algorithm
// instead of a hand-copied reimplementation that could silently drift from it.
const REACHABLE_FROM_SOURCE = reachableFrom.toString();

// JSON.stringify escapes quotes/backslashes/control characters for JS syntax, but not `<` --
// so a value containing the literal text "</script>" would still close the <script> block this
// gets embedded into early once interpolated into the template below, letting whatever text
// follows it in the exported file run as markup (or script) of its own instead of staying
// data. Escaping `<` to its Unicode escape keeps the result valid, semantically identical JS
// while making that sequence inert. Same defense-in-depth reasoning as escapeHtml above: the
// one call site below embeds a persona id (see PERSONA_ID_FORMAT's comment, services/cases.ts),
// and this is what protects an id already stored under that format's older, wider charset.
const jsonForInlineScript = (value: unknown): string =>
	JSON.stringify(value).replace(/</g, "\\u003c");

type Graph = {
	personas: Persona[];
	referrals: ReferralEdge[];
	roots: string[];
};

function scaffoldGraph(): Graph {
	const root = createEmptyPersona();
	const referred = createEmptyPersona();
	return {
		personas: [root, referred],
		referrals: [{ from_id: root.id, to_id: referred.id, conditions: "" }],
		roots: [root.id],
	};
}

// Short, human-friendly label for a persona card/option — falls back to a
// truncated id only when the name is still blank (a fresh scaffold persona).
function personaLabel(persona: Persona): string {
	return persona.name.trim() || `Persona ${persona.id.slice(0, 6)}`;
}

type FieldsInput = {
	field: string;
	label: string;
	hint?: string;
	value?: string | number | null;
	rows?: number;
	required?: boolean;
};

function fields({
	field,
	label,
	hint,
	value,
	rows = 1,
	required = false,
}: FieldsInput): string {
	return `<div class="field">
    <label class="field-label">${escapeHtml(label)}${required ? '<span class="required-mark"> *</span>' : ""}</label>
    ${hint ? `<p class="field-hint">${escapeHtml(hint)}</p>` : ""}
    <textarea class="input ${rows === 1 ? "input--line" : "input--area"}"
        data-field="${field}" rows="${rows}">${escapeHtml(value)}</textarea>
  </div>`;
}

// A file entry's actual attachment can't round-trip through this text form
// (there's no way to embed a real File in HTML an LLM edits as text), so this
// renders a placeholder per file — just the two describing fields — and the
// admin attaches the real file to each slot in-app after importing. Slots are
// matched by position, not id (FileEntryPayload carries no name/label field),
// so re-numbering on add/remove (see the inline script's renumberFiles) is
// what keeps "File 3" in the form pointing at the third entry on import.
function fileRowMarkup(
	file: {
		share_conditions?: string | null;
		perceived_contents?: string | null;
	},
	index: number,
): string {
	return `<div class="file-row" data-file="true">
    <div class="file-row-head">
      <span class="file-row-title">File ${index + 1}</span>
      <button type="button" class="btn-text btn-remove" data-action="remove-file">Remove</button>
    </div>
    ${fields({
			field: "share_conditions",
			label:
				"Describe the conditions under which the persona will share the file",
			value: file.share_conditions ?? "",
			rows: 2,
		})}
    ${fields({
			field: "perceived_contents",
			label: "What does the persona think is in this file?",
			value: file.perceived_contents ?? "",
			rows: 2,
		})}
  </div>`;
}

function filesBlockMarkup(persona: Persona | null | undefined): string {
	const rows = (persona?.files ?? [])
		.map((file, index) => fileRowMarkup(file, index))
		.join("\n");
	return `<div class="files-block">
    <div class="files-header">
      <span class="files-label">Files this persona can share</span>
      <button type="button" class="btn-add btn-add-sm" data-action="add-file">+ Add file</button>
    </div>
    <p class="field-hint">
      One entry per file this persona can share. The actual attachment is uploaded back in the
      app after import — matched by position, so upload them in the same order shown here.
    </p>
    <div class="file-list" data-role="file-list">${rows}</div>
  </div>`;
}

function personaCardMarkup(
	persona: Persona,
	isRoot: boolean,
	isFixedRoot: boolean,
): string {
	const availabilityHint = isRoot
		? "Blank = the whole simulation."
		: "Counts from when they're unlocked.";

	const headControls = isFixedRoot
		? `<span class="chip chip--fixed-root">Root &middot; required</span>`
		: `<select class="persona-type-select" data-role="persona-type">
        <option value="root" ${isRoot ? "selected" : ""}>Root (available from the start)</option>
        <option value="referred" ${isRoot ? "" : "selected"}>Referred (unlocked later)</option>
      </select>
      <button type="button" class="btn-text btn-remove" data-action="remove-persona">Remove persona</button>`;

	return `<article class="persona-card" data-persona-id="${escapeHtml(persona.id)}" data-persona-root="${isRoot}" data-fixed-root="${isFixedRoot}">
    <div class="persona-card-head">
      <span class="chip chip--persona">${escapeHtml(persona.id.slice(0, 6))}</span>
      ${headControls}
    </div>
    ${fields({ field: "name", label: "Name", value: persona.name, required: true })}
    ${fields({ field: "role", label: "Role / Title", value: persona.role, required: true })}
    ${fields({
			field: "availability_minutes",
			label: "Available for (minutes)",
			hint: availabilityHint,
			value: persona.availability_minutes,
		})}
    ${fields({
			field: "known_facts",
			label: "Persona Related Information",
			hint: "Everything this persona knows and can draw on — background, facts, figures, opinions. Be specific; this grounds every reply they give.",
			value: persona.known_facts,
			rows: 5,
		})}
    ${fields({
			field: "personality_traits",
			label: "Personality Traits",
			hint: "Tone, temperament, communication style, quirks.",
			value: persona.personality_traits,
			rows: 3,
		})}
    ${filesBlockMarkup(persona)}
  </article>`;
}

function personaOptions(personas: Persona[], selectedId: string): string {
	return personas
		.map(
			(persona) =>
				`<option value="${escapeHtml(persona.id)}" ${persona.id === selectedId ? "selected" : ""}>${escapeHtml(personaLabel(persona))}</option>`,
		)
		.join("");
}

function referralRowMarkup(
	referral: ReferralEdge,
	personas: Persona[],
): string {
	return `<div class="referral-row" data-referral="true">
    <div class="referral-selects">
      <select class="input select-persona" data-role="from">${personaOptions(personas, referral.from_id)}</select>
      <span class="referral-arrow">&rarr;</span>
      <select class="input select-persona" data-role="to">${personaOptions(personas, referral.to_id)}</select>
      <button type="button" class="btn-text btn-remove" data-action="remove-referral">Remove</button>
    </div>
    ${fields({
			field: "conditions",
			label: "When",
			hint: "The condition (in conversation) that makes the first persona introduce the second.",
			value: referral.conditions,
			rows: 2,
		})}
  </div>`;
}

const STYLES = `
  :root {
    --bg: #ffffff; --paper: #ffffff; --ink: #000000; --body: #1a1a1a;
    --muted: #6b6b6b; --muted-2: #999999; --line: #e0e0e0; --line-strong: #cccccc;
    --brand: #c5050c; --brand-dark: #9c0409; --brand-tint: #fdecec;
    --font-display: "Space Grotesk", "Century Gothic", "Avenir Next", ui-sans-serif, sans-serif;
    --font-body: "IBM Plex Sans", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--body); font-family: var(--font-body); -webkit-font-smoothing: antialiased; }
  .page { max-width: 820px; margin: 0 auto; padding: 40px 20px 100px; }
  .sheet { background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 40px clamp(20px, 6vw, 56px) 56px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 20px 44px -30px rgba(0,0,0,0.2); }
  .doc-title { font-family: var(--font-display); font-weight: 600; font-size: 24px; color: var(--ink); margin: 0 0 34px; }
  .required-mark { color: var(--brand); }
  section.block { margin-top: 40px; }
  section.block:first-of-type { margin-top: 0; }
  .eyebrow { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .eyebrow .rule { flex: 1 1 auto; height: 1px; background: var(--line); }
  .eyebrow span { font-family: var(--font-mono); font-size: 10.5px; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; color: var(--brand); white-space: nowrap; }
  h2.section-title { font-family: var(--font-display); font-size: 19px; font-weight: 600; color: var(--ink); margin: 0 0 8px; }
  .section-hint { margin: 0 0 20px; font-size: 13px; color: var(--muted); line-height: 1.6; max-width: 62ch; }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  .field-label { display: block; font-weight: 600; font-size: 13px; color: var(--ink); margin-bottom: 3px; }
  .field-hint { margin: 0 0 6px; font-size: 12px; font-style: italic; color: var(--muted); line-height: 1.5; }
  .input { width: 100%; font-family: var(--font-body); font-size: 13.5px; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; resize: vertical; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 15%, transparent); }
  .input--line { resize: none; }
  .input--area { resize: vertical; }
  select.input { -webkit-appearance: auto; appearance: auto; }
  .persona-card { border: 1px solid var(--line); border-radius: 12px; padding: 22px clamp(16px, 4vw, 26px) 26px; margin-bottom: 18px; }
  .persona-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
  .chip { font-family: var(--font-mono); font-size: 11px; font-weight: 600; border-radius: 5px; padding: 2px 7px; letter-spacing: 0.02em; }
  .chip--persona { background: var(--ink); color: var(--paper); }
  .chip--fixed-root { background: var(--brand-tint); color: var(--brand-dark); border: 1px solid color-mix(in srgb, var(--brand) 30%, transparent); border-radius: 999px; padding: 3px 10px; }
  .persona-type-select { font-family: var(--font-mono); font-size: 11.5px; border: 1px solid var(--line-strong); border-radius: 999px; padding: 3px 10px; background: var(--paper); color: var(--muted); }
  .btn-text { border: none; background: none; font-family: var(--font-body); font-size: 12.5px; font-weight: 600; color: var(--brand); cursor: pointer; padding: 2px 4px; margin-left: auto; }
  .btn-text:hover { color: var(--brand-dark); text-decoration: underline; }
  .btn-add { border: 1px dashed var(--line-strong); background: none; color: var(--muted); font-family: var(--font-body); font-weight: 600; font-size: 12.5px; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
  .btn-add:hover { border-color: var(--brand); color: var(--brand); }
  .btn-add-sm { padding: 5px 10px; font-size: 11.5px; }
  .files-block { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
  .files-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .files-label { font-weight: 600; font-size: 13px; color: var(--ink); }
  .file-list { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
  .file-row { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .file-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .file-row-title { font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
  .referral-row { border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
  .referral-selects { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .select-persona { width: auto; min-width: 90px; flex: none; }
  .referral-arrow { color: var(--brand); font-weight: 600; }
  @media (max-width: 560px) { .sheet { padding: 28px 16px 40px; } }
`;

export type BuildHTMLFormInput = {
	caseName: string;
	accessCode: string;
	simulationDurationMinutes: number | null;
	initialBrief: string;
	commonInformation: string;
	personas?: Persona[] | null;
	referrals?: ReferralEdge[] | null;
	roots?: string[] | null;
};

export function buildHTMLForm({
	caseName,
	accessCode,
	simulationDurationMinutes,
	initialBrief,
	commonInformation,
	personas,
	referrals,
	roots,
}: BuildHTMLFormInput): string {
	const graph: Graph =
		Array.isArray(personas) && personas.length > 0
			? { personas, referrals: referrals ?? [], roots: roots ?? [] }
			: scaffoldGraph();

	// The exported form's own "+ Add persona" always leaves the first root
	// (whichever is exported as roots[0]) as the one mandatory, un-removable
	// root — same invariant the app itself enforces (at least one root).
	const fixedRootId = graph.roots[0] ?? null;

	const personaCards = graph.personas
		.map((persona) =>
			personaCardMarkup(
				persona,
				graph.roots.includes(persona.id),
				persona.id === fixedRootId,
			),
		)
		.join("\n");
	const referralRows = graph.referrals
		.map((referral) => referralRowMarkup(referral, graph.personas))
		.join("\n");

	const title = caseName
		? `${escapeHtml(caseName)} — Case Lab Import Form`
		: "Case Lab Import Form";

	return `<!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>${title}</title>
            <style>${STYLES}</style>
        </head>
        <body>
            <div class="page">
                <article class="sheet">
                    <h1 class="doc-title">Wisconsin Case Lab — Case Import Form</h1>

                    <section class="block">
                        <div class="eyebrow">
                            <span class="rule"></span><span>Case Setup</span><span class="rule"></span>
                        </div>
                        <h2 class="section-title">Case Setup</h2>
                        ${fields({
													field: "case_name",
													label: "Case Name",
													value: caseName,
													required: true,
												})}
                        ${fields({
													field: "access_code",
													label: "Access Code",
													hint: "Students type this to start the simulation.",
													value: accessCode,
													required: true,
												})}
                        ${fields({
													field: "simulation_duration_minutes",
													label: "Simulation Duration (minutes)",
													hint: "Leave blank for unlimited.",
													value: simulationDurationMinutes,
												})}
                        ${fields({
													field: "initial_brief",
													label: "Initial Brief",
													hint: "What the student reads before the simulation begins — sets up the scenario and their objective.",
													value: initialBrief,
													rows: 5,
													required: true,
												})}
                        ${fields({
													field: "common_information",
													label: "Case Background",
													hint: "Shared context every persona in this case implicitly knows.",
													value: commonInformation,
													rows: 5,
												})}
                    </section>

                    <section class="block">
                        <div class="eyebrow">
                            <span class="rule"></span><span>Personas</span><span class="rule"></span>
                        </div>

                        <h2 class="section-title">Personas</h2>
                        <p class="section-hint">
                            Every persona gets one card, whether available from the start (Root) or unlocked later via a
                            referral (Referred) — switch that with the dropdown on each card.
                        </p>
                        <div id="personas-list">${personaCards}</div>
                        <button type="button" class="btn-add" id="add-persona-btn">+ Add persona</button>
                    </section>

                    <section class="block">
                        <div class="eyebrow">
                            <span class="rule"></span><span>Referrals</span><span class="rule"></span>
                        </div>

                        <h2 class="section-title">Referrals</h2>
                        <p class="section-hint">
                            The first persona introduces the second once the condition below is met in conversation.
                        </p>
                      <div id="referrals-list">${referralRows}</div>
                      <button type="button" class="btn-add" id="add-referral-btn">+ Add referral</button>
                    </section>
                </article>
            </div>

            <template id="persona-template">
                ${personaCardMarkup(createEmptyPersona(), true, false)}
            </template>

            <template id="referral-template">
                ${referralRowMarkup(createEmptyReferral(), graph.personas)}
            </template>

            <template id="file-template">
                ${fileRowMarkup({ share_conditions: "", perceived_contents: "" }, 0)}
            </template>

            <script>
(function () {
  var FIXED_ROOT_ID = ${jsonForInlineScript(fixedRootId)};
  var personasList = document.getElementById('personas-list');
  var referralsList = document.getElementById('referrals-list');
  var personaTemplate = document.getElementById('persona-template');
  var referralTemplate = document.getElementById('referral-template');
  var fileTemplate = document.getElementById('file-template');

  // The exact same reachability algorithm graph.svelte.ts's CaseGraph is built on --
  // embedded here, not hand-copied, so this form's removal cascade can't silently drift
  // from the live app's.
  var reachableFrom = ${REACHABLE_FROM_SOURCE};

  function currentPersonas() {
    return Array.prototype.map.call(
      document.querySelectorAll('[data-persona-id]'),
      function (el) {
        var nameField = el.querySelector('textarea[data-field="name"]');
        return { id: el.getAttribute('data-persona-id'), name: (nameField && nameField.value.trim()) || '' };
      }
    );
  }

  function currentRoots() {
    return Array.prototype.map.call(
      document.querySelectorAll('[data-persona-root="true"]'),
      function (el) { return el.getAttribute('data-persona-id'); }
    );
  }

  function currentReferralEdges() {
    return Array.prototype.map.call(document.querySelectorAll('.referral-row'), function (row) {
      return {
        from_id: row.querySelector('select[data-role="from"]').value,
        to_id: row.querySelector('select[data-role="to"]').value,
      };
    });
  }

  function removeReferralEdgesTouching(id) {
    document.querySelectorAll('.referral-row').forEach(function (row) {
      var from = row.querySelector('select[data-role="from"]').value;
      var to = row.querySelector('select[data-role="to"]').value;
      if (from === id || to === id) row.remove();
    });
  }

  // Removes every persona no longer reachable from a root by following the referral
  // edges currently in the form -- same rule graph.svelte.ts's removeSubtree/
  // removeReferralsFrom enforce: a persona introduced only by a referral that's gone
  // doesn't stay behind as an orphan.
  function pruneUnreachablePersonas() {
    var stillReachable = reachableFrom(currentRoots(), currentReferralEdges());
    document.querySelectorAll('[data-persona-id]').forEach(function (card) {
      var id = card.getAttribute('data-persona-id');
      if (stillReachable.has(id)) return;
      removeReferralEdgesTouching(id);
      card.remove();
    });
  }

  // Built with the Option constructor, not innerHTML + string-concatenated markup: a persona
  // name is admin-authored text that reaches here unescaped (unlike personaOptions() above,
  // which builds the export's INITIAL <option>s server-side through escapeHtml), and the
  // Option constructor always sets its label as a text node -- never parsed as HTML -- so an
  // id or name containing '"', '<', or '>' can't break out of an attribute or inject markup
  // into whichever admin's browser has this file open. Same threat PERSONA_ID_FORMAT's own
  // comment (services/cases.ts) defends against for ids; this closes the matching gap for
  // names, which that format restriction doesn't cover.
  function refreshReferralOptions() {
    var personas = currentPersonas();
    document.querySelectorAll('.referral-row').forEach(function (row) {
      ['from', 'to'].forEach(function (role) {
        var select = row.querySelector('select[data-role="' + role + '"]');
        var current = select.value;
        select.innerHTML = '';
        personas.forEach(function (persona) {
          var label = persona.name || ('Persona ' + persona.id.slice(0, 6));
          select.appendChild(new Option(label, persona.id, false, persona.id === current));
        });
        var ids = personas.map(function (p) { return p.id; });
        if (!ids.includes(current) && ids.length) select.value = ids[0];
      });
    });
  }

  function addPersona() {
    var id = crypto.randomUUID();
    var frag = personaTemplate.content.cloneNode(true);
    var card = frag.querySelector('.persona-card');
    card.setAttribute('data-persona-id', id);
    card.querySelector('.chip--persona').textContent = id.slice(0, 6);
    personasList.appendChild(frag);
    refreshReferralOptions();
  }

  function removePersona(card) {
    var id = card.getAttribute('data-persona-id');
    // The fixed first root has no "Remove persona" button (see
    // personaCardMarkup), but guard here too — it's the case's one
    // mandatory root persona.
    if (id === FIXED_ROOT_ID) return;
    removeReferralEdgesTouching(id);
    card.remove();
    pruneUnreachablePersonas();
    refreshReferralOptions();
  }

  function addReferral() {
    var personas = currentPersonas();
    if (personas.length < 1) { window.alert('Add at least one persona before adding a referral.'); return; }
    var frag = referralTemplate.content.cloneNode(true);
    referralsList.appendChild(frag);
    refreshReferralOptions();
  }

  function removeReferral(row) {
    row.remove();
    pruneUnreachablePersonas();
    refreshReferralOptions();
  }

  // Files carry no id of their own (see fileRowMarkup's comment) — the label
  // just tracks DOM position, so it has to be recomputed after every add/remove.
  function renumberFiles(fileList) {
    fileList.querySelectorAll('.file-row').forEach(function (row, index) {
      row.querySelector('.file-row-title').textContent = 'File ' + (index + 1);
    });
  }

  function addFile(fileList) {
    var frag = fileTemplate.content.cloneNode(true);
    fileList.appendChild(frag);
    renumberFiles(fileList);
  }

  function removeFile(row) {
    var fileList = row.closest('.file-list');
    row.remove();
    renumberFiles(fileList);
  }

  document.getElementById('add-persona-btn').addEventListener('click', addPersona);
  document.getElementById('add-referral-btn').addEventListener('click', addReferral);

  document.addEventListener('click', function (event) {
    var action = event.target.getAttribute && event.target.getAttribute('data-action');
    if (!action) return;
    if (action === 'remove-persona') removePersona(event.target.closest('.persona-card'));
    else if (action === 'remove-referral') removeReferral(event.target.closest('.referral-row'));
    else if (action === 'add-file') {
      var card = event.target.closest('.persona-card');
      addFile(card.querySelector('[data-role="file-list"]'));
    } else if (action === 'remove-file') removeFile(event.target.closest('.file-row'));
  });

  document.addEventListener('change', function (event) {
    if (event.target.getAttribute('data-role') === 'persona-type') {
      var card = event.target.closest('.persona-card');
      card.setAttribute('data-persona-root', event.target.value === 'root' ? 'true' : 'false');
    }
    if (event.target.getAttribute('data-field') === 'name') {
      refreshReferralOptions();
    }
  });
})();
</script>
        </body>
    </html>`;
}

export function downloadForm(html: string): void {
	downloadBlob(
		new Blob([html], { type: "text/html;charset=utf-8" }),
		"export case.html",
	);
}

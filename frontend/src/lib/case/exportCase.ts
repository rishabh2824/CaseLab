// Exports an empty case form so admins can autofill it with AI

import { slugify } from "../format.js";
import type { Persona, ReferralEdge } from "../types.js";
import { createEmptyPersona } from "./draft.js";

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

const blank = (value: unknown): string => (value == null ? "" : String(value));

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
        data-field="${field}" rows="${rows}">${escapeHtml(blank(value))}
    </textarea>
  </div>`;
}

function fileShare(persona: Persona | null | undefined): string {
	const canShare = (persona?.files ?? []).length > 0 ? "yes" : "no";
	return `<div class="field">
    <label class="field-label">Can this Persona share files?</label>
    <p class="field-hint">Details will be entered in app.</p>
    <select class="input select-yesno" data-field="can_share_files">
      <option value="no" ${canShare === "no" ? "selected" : ""}>No</option>
      <option value="yes" ${canShare === "yes" ? "selected" : ""}>Yes</option>
    </select>
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

	return `<article class="persona-card" data-persona-id="${persona.id}" data-persona-root="${isRoot}" data-fixed-root="${isFixedRoot}">
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
    ${fileShare(persona)}
  </article>`;
}

function personaOptions(personas: Persona[], selectedId: string): string {
	return personas
		.map(
			(persona) =>
				`<option value="${persona.id}" ${persona.id === selectedId ? "selected" : ""}>${escapeHtml(personaLabel(persona))}</option>`,
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
                <article class="persona-card" data-persona-id="" data-persona-root="true">
                    <div class="persona-card-head">
                        <span class="chip chip--persona"></span>
                        <select class="persona-type-select" data-role="persona-type">
                            <option value="root" selected>Root (available from the start)</option>
                            <option value="referred">Referred (unlocked later)</option>
                        </select>
                        <button type="button" class="btn-text btn-remove" data-action="remove-persona">Remove persona</button>
                    </div>

                    ${fields({
											field: "name",
											label: "Name",
											value: "",
											required: true,
										})}
                    ${fields({
											field: "role",
											label: "Role / Title",
											value: "",
											required: true,
										})}
                    ${fields({
											field: "availability_minutes",
											label: "Available for (minutes)",
											hint: "Blank = the whole simulation.",
											value: "",
										})}
                    ${fields({
											field: "known_facts",
											label: "Persona Related Information",
											hint: "Everything this persona knows and can draw on — background, facts, figures, opinions. Be specific; this grounds every reply they give.",
											value: "",
											rows: 5,
										})}
                    ${fields({
											field: "personality_traits",
											label: "Personality Traits",
											hint: "Tone, temperament, communication style, quirks.",
											value: "",
											rows: 3,
										})}
                    ${fileShare(null)}
                </article>
            </template>

            <template id="referral-template">
          <div class="referral-row" data-referral="true">
            <div class="referral-selects">
              <select class="input select-persona" data-role="from"></select>
              <span class="referral-arrow">&rarr;</span>
              <select class="input select-persona" data-role="to"></select>
              <button type="button" class="btn-text btn-remove" data-action="remove-referral">Remove</button>
            </div>
            ${fields({
							field: "conditions",
							label: "When",
							hint: "The condition (in conversation) that makes the first persona introduce the second.",
							value: "",
							rows: 2,
						})}
          </div>
        </template>

            <script>
(function () {
  var FIXED_ROOT_ID = ${JSON.stringify(fixedRootId)};
  var personasList = document.getElementById('personas-list');
  var referralsList = document.getElementById('referrals-list');
  var personaTemplate = document.getElementById('persona-template');
  var referralTemplate = document.getElementById('referral-template');

  function currentPersonas() {
    return Array.prototype.map.call(
      document.querySelectorAll('[data-persona-id]'),
      function (el) {
        var nameField = el.querySelector('textarea[data-field="name"]');
        return { id: el.getAttribute('data-persona-id'), name: (nameField && nameField.value.trim()) || '' };
      }
    );
  }

  function nextPersonaId() {
    var max = 0;
    document.querySelectorAll('[data-persona-id]').forEach(function (el) {
      var raw = el.getAttribute('data-persona-id') || '';
      var num = parseInt(raw.replace(/^[A-Z]/, ''), 10);
      if (!isNaN(num) && num > max) max = num;
    });
    return 'P' + (max + 1);
  }

  function refreshReferralOptions() {
    var personas = currentPersonas();
    document.querySelectorAll('.referral-row').forEach(function (row) {
      ['from', 'to'].forEach(function (role) {
        var select = row.querySelector('select[data-role="' + role + '"]');
        var current = select.value;
        select.innerHTML = personas.map(function (persona) {
          var sel = persona.id === current ? ' selected' : '';
          var label = persona.name || ('Persona ' + persona.id.slice(0, 6));
          return '<option value="' + persona.id + '"' + sel + '>' + label + '</option>';
        }).join('');
        var ids = personas.map(function (p) { return p.id; });
        if (!ids.includes(current) && ids.length) select.value = ids[0];
      });
    });
  }

  function addPersona() {
    var id = nextPersonaId();
    var frag = personaTemplate.content.cloneNode(true);
    var card = frag.querySelector('.persona-card');
    card.setAttribute('data-persona-id', id);
    card.querySelector('.chip--persona').textContent = id;
    personasList.appendChild(frag);
    refreshReferralOptions();
  }

  function removePersona(card) {
    var id = card.getAttribute('data-persona-id');
    // The fixed first root has no "Remove persona" button (see
    // personaCardMarkup), but guard here too — it's the case's one
    // mandatory root persona.
    if (id === FIXED_ROOT_ID) return;
    document.querySelectorAll('.referral-row').forEach(function (row) {
      var from = row.querySelector('select[data-role="from"]').value;
      var to = row.querySelector('select[data-role="to"]').value;
      if (from === id || to === id) row.remove();
    });
    card.remove();
    refreshReferralOptions();
  }

  function addReferral() {
    var personas = currentPersonas();
    if (personas.length < 1) { window.alert('Add at least one persona before adding a referral.'); return; }
    var frag = referralTemplate.content.cloneNode(true);
    referralsList.appendChild(frag);
    refreshReferralOptions();
  }

  document.getElementById('add-persona-btn').addEventListener('click', addPersona);
  document.getElementById('add-referral-btn').addEventListener('click', addReferral);

  document.addEventListener('click', function (event) {
    var action = event.target.getAttribute && event.target.getAttribute('data-action');
    if (!action) return;
    if (action === 'remove-persona') removePersona(event.target.closest('.persona-card'));
    else if (action === 'remove-referral') event.target.closest('.referral-row').remove();
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

export function downloadForm(html: string, caseName: string): void {
	const slug = slugify(caseName);
	const filename = `${slug || "new-case"}.html`;
	const file = new Blob([html], { type: "text/html;charset=utf-8" });
	const url = URL.createObjectURL(file);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { expect, test } from '@playwright/test'

// A run-state payload shaped exactly like the backend's start_simulation /
// get_simulation_state response, with one available contact.
const RUN_ID = 'testrun123'
const runState = (overrides = {}) => ({
    run_id: RUN_ID,
    case: {
        id: 'case1',
        case_name: 'Sterling Industries',
        initial_brief: 'Reduce office supply costs.',
        simulation_duration: 45,
    },
    contacts: [
        {
            id: 'mary',
            name: 'Mary',
            role: 'Chief Financial Officer',
            availability_duration: null,
            available: true,
            available_in: null,
            expires_in: null,
            is_referred: false,
            chat_ended: false,
            chat_end_reason: null,
            warning_count: 0,
            profile_photo: null,
        },
    ],
    active_persona_id: 'mary',
    shared_files: [],
    histories: {},
    notes: '',
    ...overrides,
})

// One message turn as an SSE body, matching stream_message's streamed order
// (delta* -> meta -> done). The reply text is split across two delta frames to
// exercise the incremental renderer the way real token streaming does.
const messageSse = (reply) => {
    const split = Math.ceil(reply.length / 2)
    return [
        'event: delta',
        `data: ${JSON.stringify({ text: reply.slice(0, split) })}`,
        '',
        'event: delta',
        `data: ${JSON.stringify({ text: reply.slice(split) })}`,
        '',
        'event: meta',
        `data: ${JSON.stringify({ new_contacts: [], shared_files: [], chat_ended: false, chat_end_reason: null, warning_count: 0 })}`,
        '',
        'event: done',
        `data: ${JSON.stringify({ reply, history: [{ role: 'user', content: 'What vendor do we use?' }, { role: 'assistant', content: reply }] })}`,
        '',
        '',
    ].join('\n')
}

// Wire up every backend endpoint the student flow touches, deterministically.
async function mockBackend(page, { reply }) {
    await page.route('**/api/simulations/start', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runState()) })
    })
    await page.route(`**/api/simulations/${RUN_ID}/message`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: messageSse(reply) })
    })
    await page.route(`**/api/simulations/${RUN_ID}/notes`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notes: '' }) })
    })
    await page.route(`**/api/simulations/${RUN_ID}`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runState()) })
    })
}

test('student enters an access code and messages a persona', async ({ page }) => {
    await mockBackend(page, { reply: 'Our current vendor is Acme Supplies.' })

    await page.goto('/')

    // Enter the access code and open the case (landing page submits POST /start).
    await page.getByPlaceholder('Enter access code').fill('sterling')
    await page.getByRole('button', { name: 'Open Case' }).click()

    // Success navigates to the student view; brief + contact render from the cache.
    await expect(page).toHaveURL(/\/student$/)
    await expect(page.getByText('Reduce office supply costs.')).toBeVisible()
    await expect(page.getByText('Mary').first()).toBeVisible()

    // Send a message and assert the streamed persona reply appears.
    await page.getByPlaceholder('Type your message...').fill('What vendor do we use?')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText('What vendor do we use?')).toBeVisible()
    await expect(page.getByText('Our current vendor is Acme Supplies.')).toBeVisible()
})

test('an invalid access code surfaces an inline error', async ({ page }) => {
    await page.route('**/api/simulations/start', async (route) => {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No case found.' }) })
    })

    await page.goto('/')
    await page.getByPlaceholder('Enter access code').fill('wrong-code')
    await page.getByRole('button', { name: 'Open Case' }).click()

    // The landing page shows the error inline and stays put (no navigation).
    await expect(page.getByText('Invalid access code.')).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
})

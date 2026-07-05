// PDF export of a student's chat transcript, built with jsPDF.
//
// jsPDF's core fonts (Helvetica) use WinAnsi encoding, which natively supports
// smart quotes/en-dashes/ellipses and handles PDF string escaping internally —
// so unlike a hand-rolled writer, no manual character-range stripping or
// paren/backslash escaping is needed here.

import jsPDF from 'jspdf'
import { slugify } from './Helpers.js'

const PAGE_MARGIN = 54
const BODY_FONT_SIZE = 10
const TITLE_FONT_SIZE = 14
const LINE_HEIGHT = 15
const TITLE_GAP = LINE_HEIGHT * 1.5

export const slugifyFileName = (value) => slugify(value) || 'case-lab-chat-export'

// Writes a titled section starting at the current page, adding real page
// breaks (fixed US Letter height) whenever content overflows.
const writeSection = (doc, title, bodyLines) => {
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const maxWidth = pageWidth - PAGE_MARGIN * 2
    let y = PAGE_MARGIN

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(TITLE_FONT_SIZE)
    doc.text(title, PAGE_MARGIN, y)
    y += TITLE_GAP

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(BODY_FONT_SIZE)

    for (const rawLine of bodyLines) {
        const wrapped = rawLine ? doc.splitTextToSize(rawLine, maxWidth) : ['']
        for (const line of wrapped) {
            if (y > pageHeight - PAGE_MARGIN) {
                doc.addPage()
                y = PAGE_MARGIN
            }
            doc.text(line, PAGE_MARGIN, y)
            y += LINE_HEIGHT
        }
    }
}

export const buildChatPdfBlob = (personas, notes = '') => {
    const printablePersonas =
        personas.length > 0 ? personas : [{ name: 'No unlocked personas', role: '', messages: [] }]
    const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true })

    const trimmedNotes = notes.trim()
    writeSection(doc, 'My Notes', trimmedNotes ? trimmedNotes.split(/\r?\n/) : ['No notes.'])

    printablePersonas.forEach((persona) => {
        doc.addPage()
        const speakerName = persona.name || 'Persona'
        const title = persona.role ? `${speakerName} - ${persona.role}` : speakerName
        const messages = persona.messages ?? []
        const lines =
            messages.length === 0
                ? ['No chat history.']
                : messages.flatMap((message) => {
                      const label = message.role === 'user' ? 'You' : speakerName
                      // Label only prefixes the message's first physical line
                      // (matching a normal chat-transcript convention); any
                      // embedded newlines in the content become their own
                      // (unlabeled) lines, each still subject to width-wrapping.
                      const messageLines = `${label}: ${message.content ?? ''}`.split(/\r?\n/)
                      return [...messageLines, '']
                  })
        writeSection(doc, title, lines)
    })

    return doc.output('blob')
}

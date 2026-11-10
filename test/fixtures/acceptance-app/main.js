import { normalizeQuery } from './normalize.js'

export function searchNotes(notes, query) {
  const normalized = normalizeQuery(query)
  return notes.filter((note) => normalizeQuery(note.title).includes(normalized))
}

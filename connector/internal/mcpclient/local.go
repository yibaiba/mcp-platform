package mcpclient

import "errors"

func (m *Manager) InvalidateResource(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var result error
	for key, entry := range m.entries {
		if entry.ResourceID == id || entry.SourceID == id {
			result = errors.Join(result, closeEntry(entry))
			delete(m.entries, key)
		}
	}
	return result
}

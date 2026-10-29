package local

import "fmt"

// Subscribe supplements the platform notifier; callbacks run after releasing mu.
func (s *Service) Subscribe(notify func()) func() {
	s.mu.Lock()
	if s.subscribers == nil {
		s.subscribers = map[uint64]func(){}
	}
	s.nextSubscriber++
	id := s.nextSubscriber
	s.subscribers[id] = notify
	s.mu.Unlock()
	return func() { s.mu.Lock(); delete(s.subscribers, id); s.mu.Unlock() }
}

// notifierLocked captures listeners while the state lock is held.
func (s *Service) notifierLocked() func() {
	listeners := make([]func(), 0, len(s.subscribers)+1)
	if s.onchange != nil {
		listeners = append(listeners, s.onchange)
	}
	for _, notify := range s.subscribers {
		listeners = append(listeners, notify)
	}
	return func() {
		for _, notify := range listeners {
			notify()
		}
	}
}

// BindTarget allows an offline manager to pair without replacing its inventory.
func (s *Service) BindTarget(target string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.SyncTarget != "" && s.state.SyncTarget != target {
		return fmt.Errorf("local selections belong to another platform device; use a separate data directory")
	}
	previous := s.state.SyncTarget
	s.state.SyncTarget = target
	if err := s.options.Store.Save(s.state); err != nil {
		s.state.SyncTarget = previous
		return err
	}
	return nil
}

// Wait waits for background mutations after the owning runtime cancels its context.
func (s *Service) Wait() {
	s.mu.Lock()
	s.mu.Unlock()
	s.workers.Wait()
}

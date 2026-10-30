import { createContext } from 'react';

// Custom controls notify the enclosing Form after changing their submitted value.
export const FormChanges = createContext<(() => void) | undefined>(undefined);

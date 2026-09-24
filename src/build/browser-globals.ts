import * as marked from 'marked';

(globalThis as any).marked ??= marked;
(globalThis as any).DOMPurify ??= { sanitize: (s: string) => s };

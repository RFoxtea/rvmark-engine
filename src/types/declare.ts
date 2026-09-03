/**
 * Every node type declaration, in one import.
 *
 * The envoy imports this to populate the registry: resolveShape needs to know a
 * type's address-valued attributes, and cannot reach the handlers themselves —
 * those pull in DOM. Each handler additionally imports its own declaration, so
 * the client cannot load a type without it.
 */

import './_shared.declare.js';
import './text.declare.js';
import './block.declare.js';
import './video.declare.js';
import './iframe.declare.js';
import './image.declare.js';
import './tr.declare.js';
import './table.declare.js';
import './hr.declare.js';
import './gap.declare.js';
import './blastocyte.declare.js';

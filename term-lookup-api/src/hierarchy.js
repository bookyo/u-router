const { ParentNotFoundError, ParentCycleError } = require('./errors');

function ancestorRows(find, parentId, selfId) {
  const seen = new Set(selfId === undefined ? [] : [selfId]);
  const rows = [];
  let currentId = parentId;
  while (currentId !== null) {
    if (seen.has(currentId)) throw new ParentCycleError();
    seen.add(currentId);
    const row = find(currentId);
    if (!row) throw new ParentNotFoundError();
    rows.push(row);
    currentId = row.parent_id ?? null;
  }
  return rows.reverse();
}

module.exports = { ancestorRows };

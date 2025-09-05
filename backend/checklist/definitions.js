// backend/checklist/definitions.js
// Minimal v1: tie items to "documents" by kind. More logic can be added later.
const CHECKLIST = {
    house: [
      { id: 'title_search', label: 'Title search document', required: true },
      { id: 'pool_safety',  label: 'Pool safety certificate (if pool)', required: true },
      { id: 'smoke_alarm',  label: 'Smoke alarm compliance certificate', required: true },
    ],
    unit: [
      { id: 'title_search', label: 'Title search document', required: true },
      { id: 'bcorp_info',   label: 'Body corporate information certificate', required: true },
      { id: 'smoke_alarm',  label: 'Smoke alarm compliance certificate', required: true },
    ],
  };
  
  function getChecklistForType(type = 'house') {
    return CHECKLIST[type] || CHECKLIST.house;
  }
  
  module.exports = { CHECKLIST, getChecklistForType };
  
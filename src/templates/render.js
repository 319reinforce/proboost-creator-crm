const VARIABLE_REGEX = /\$\{([a-zA-Z0-9_]+)\}/g;

function findVariables(template) {
  const variables = new Set();
  for (const match of String(template || '').matchAll(VARIABLE_REGEX)) {
    variables.add(match[1]);
  }
  return Array.from(variables);
}

function renderString(template, variables) {
  return String(template || '').replace(VARIABLE_REGEX, (_, key) => {
    const value = variables[key];
    return value == null ? `\${${key}}` : String(value);
  });
}

function validateVariables(template, variables) {
  const required = findVariables(template);
  const missing = required.filter(key => variables[key] == null || variables[key] === '');
  return {
    ok: missing.length === 0,
    required,
    missing,
  };
}

function renderTemplate(template, variables) {
  const subjectValidation = validateVariables(template.subject_template, variables);
  const bodyValidation = validateVariables(template.body_template, variables);
  const missing = Array.from(new Set([
    ...subjectValidation.missing,
    ...bodyValidation.missing,
  ]));

  return {
    ok: missing.length === 0,
    missing,
    subject: renderString(template.subject_template, variables),
    body: renderString(template.body_template, variables),
  };
}

function getActiveTemplate(db, name) {
  return db.prepare(`
    SELECT *
    FROM templates
    WHERE name = ?
      AND is_active = 1
    ORDER BY version DESC
    LIMIT 1
  `).get(name);
}

module.exports = {
  findVariables,
  renderString,
  validateVariables,
  renderTemplate,
  getActiveTemplate,
};

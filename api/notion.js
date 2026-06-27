const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

function headers() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
}

async function nfetch(method, path, body) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function queryDb(dbId, filter) {
  const body = filter ? { filter } : {};
  const res = await nfetch('POST', `/databases/${dbId}/query`, body);
  return res.results || [];
}

// ── Property helpers ──

const gt = p => p?.rich_text?.[0]?.plain_text || '';
const gti = p => p?.title?.[0]?.plain_text || '';
const gs = p => p?.select?.name || '';
const gn = p => p?.number ?? 0;
const gd = p => p?.date?.start || '';
const gc = p => p?.checkbox || false;
const grel = p => (p?.relation || []).map(r => r.id);

const bt = v => ({ title: [{ type: 'text', text: { content: v || '' } }] });
const brt = v => ({ rich_text: [{ type: 'text', text: { content: (v || '').slice(0, 2000) } }] });
const bs = v => v ? { select: { name: v } } : { select: null };
const bn = v => ({ number: v ?? null });
const bd = v => v ? { date: { start: v } } : { date: null };
const bc = v => ({ checkbox: !!v });
const brel = ids => ({ relation: (ids || []).map(id => ({ id })) });

// ── Status mappings ──

const TO_NOTION = { backlog: 'backlog', thisweek: 'this-week', inprogress: 'in-progress', done: 'done', snoozed: 'snoozed' };
const FROM_NOTION = { backlog: 'backlog', 'this-week': 'thisweek', 'in-progress': 'inprogress', done: 'done', snoozed: 'snoozed' };

// ── Page mappers ──

function mapProject(page) {
  const p = page.properties;
  return {
    notionId: page.id,
    name: gti(p.Name),
    status: gs(p.Status),
    progress: gn(p.Progress),
    nextStep: gt(p['Next Step']),
    dir: gt(p.Directory),
  };
}

function mapTask(page) {
  const p = page.properties;
  const milestoneNotionId = grel(p.Milestone)[0] || '';
  return {
    notionId: page.id,
    id: page.id,
    title: gti(p.Name),
    desc: gt(p.Description),
    status: FROM_NOTION[gs(p.Status)] || 'backlog',
    priority: gs(p.Priority) || 'mid',
    due: gd(p['Due Date']),
    weekly: gc(p['Weekly Focus']),
    milestoneNotionId,
    milestone: milestoneNotionId,
  };
}

function mapMilestone(page) {
  const p = page.properties;
  return {
    notionId: page.id,
    id: page.id,
    name: gti(p.Name),
    date: gd(p['Target Date']),
    status: gs(p.Status) || 'upcoming',
  };
}

// ── Project lookup / create ──

async function findOrCreateProject(name) {
  const dbId = process.env.NOTION_PROJECTS_DB_ID;
  const pages = await queryDb(dbId, { property: 'Name', title: { equals: name } });
  if (pages.length > 0) return pages[0].id;
  const page = await nfetch('POST', '/pages', {
    parent: { database_id: dbId },
    properties: { Name: bt(name) },
  });
  return page.id;
}

// ── Route handlers ──

async function getProjects() {
  const pages = await queryDb(process.env.NOTION_PROJECTS_DB_ID);
  return pages.map(mapProject);
}

async function upsertProject(body) {
  const { name, status, progress, nextStep, dir } = body;
  const pages = await queryDb(process.env.NOTION_PROJECTS_DB_ID, {
    property: 'Name', title: { equals: name },
  });
  const props = {};
  if (status !== undefined) props.Status = bs(status);
  if (progress !== undefined) props.Progress = bn(progress);
  if (nextStep !== undefined) props['Next Step'] = brt(nextStep);
  if (dir !== undefined) props.Directory = brt(dir);

  if (pages.length > 0) {
    await nfetch('PATCH', `/pages/${pages[0].id}`, { properties: props });
    return { notionId: pages[0].id };
  }
  props.Name = bt(name);
  const page = await nfetch('POST', '/pages', {
    parent: { database_id: process.env.NOTION_PROJECTS_DB_ID },
    properties: props,
  });
  return { notionId: page.id };
}

async function getPM(projectName) {
  const projPages = await queryDb(process.env.NOTION_PROJECTS_DB_ID, {
    property: 'Name', title: { equals: projectName },
  });
  if (projPages.length === 0) return { tasks: [], milestones: [] };

  const projId = projPages[0].id;
  const relFilter = id => ({ property: 'Project', relation: { contains: id } });

  const [taskPages, msPages] = await Promise.all([
    queryDb(process.env.NOTION_TASKS_DB_ID, relFilter(projId)),
    queryDb(process.env.NOTION_MILESTONES_DB_ID, relFilter(projId)),
  ]);

  return { tasks: taskPages.map(mapTask), milestones: msPages.map(mapMilestone) };
}

async function createTask(body) {
  const { projectName, milestoneNotionId, title, desc, status, priority, due, weekly } = body;
  const projId = await findOrCreateProject(projectName);
  const props = {
    Name: bt(title),
    Status: bs(TO_NOTION[status] || status || 'backlog'),
    Priority: bs(priority || 'mid'),
    Description: brt(desc),
    'Weekly Focus': bc(weekly),
    Project: brel([projId]),
    Owner: bs('human'),
    Source: bs('manual'),
  };
  if (due) props['Due Date'] = bd(due);
  if (milestoneNotionId) props.Milestone = brel([milestoneNotionId]);
  const page = await nfetch('POST', '/pages', {
    parent: { database_id: process.env.NOTION_TASKS_DB_ID },
    properties: props,
  });
  return mapTask(page);
}

async function updateTask(id, body) {
  const { title, desc, status, priority, due, weekly, milestoneNotionId } = body;
  const props = {};
  if (title !== undefined) props.Name = bt(title);
  if (status !== undefined) props.Status = bs(TO_NOTION[status] || status);
  if (priority !== undefined) props.Priority = bs(priority);
  if (desc !== undefined) props.Description = brt(desc);
  if (weekly !== undefined) props['Weekly Focus'] = bc(weekly);
  if (due !== undefined) props['Due Date'] = bd(due);
  if (milestoneNotionId !== undefined) props.Milestone = brel(milestoneNotionId ? [milestoneNotionId] : []);
  const page = await nfetch('PATCH', `/pages/${id}`, { properties: props });
  return mapTask(page);
}

async function createMilestone(body) {
  const { projectName, name, date, status } = body;
  const projId = await findOrCreateProject(projectName);
  const props = {
    Name: bt(name),
    Status: bs(status || 'upcoming'),
    Project: brel([projId]),
  };
  if (date) props['Target Date'] = bd(date);
  const page = await nfetch('POST', '/pages', {
    parent: { database_id: process.env.NOTION_MILESTONES_DB_ID },
    properties: props,
  });
  return mapMilestone(page);
}

async function updateMilestone(id, body) {
  const { name, date, status } = body;
  const props = {};
  if (name !== undefined) props.Name = bt(name);
  if (status !== undefined) props.Status = bs(status);
  if (date !== undefined) props['Target Date'] = bd(date);
  const page = await nfetch('PATCH', `/pages/${id}`, { properties: props });
  return mapMilestone(page);
}

async function archivePage(id) {
  await nfetch('PATCH', `/pages/${id}`, { archived: true });
  return { ok: true };
}

// ── Weekly Plans ──

function mapWeeklyPlan(page) {
  const p = page.properties;
  return {
    notionId: page.id,
    name: gti(p.Name),
    weekStart: gd(p['Week Start']),
    status: gs(p.Status) || 'planning',
    keyOutcomes: gt(p['Key Outcomes']),
    focusTasks: grel(p['Focus Tasks']),
    activeProjects: grel(p['Active Projects']),
  };
}

async function getOrCreateWeeklyPlan(weekStart) {
  const dbId = process.env.NOTION_WEEKLY_PLANS_DB_ID;
  const pages = await queryDb(dbId, { property: 'Week Start', date: { equals: weekStart } });
  if (pages.length > 0) return mapWeeklyPlan(pages[0]);
  const page = await nfetch('POST', '/pages', {
    parent: { database_id: dbId },
    properties: {
      Name: bt(`Week of ${weekStart}`),
      'Week Start': bd(weekStart),
      Status: bs('planning'),
    },
  });
  return mapWeeklyPlan(page);
}

async function updateWeeklyPlan(id, body) {
  const { status, keyOutcomes, focusTaskIds, activeProjectIds } = body;
  const props = {};
  if (status) props.Status = bs(status);
  if (keyOutcomes !== undefined) props['Key Outcomes'] = brt(keyOutcomes);
  if (focusTaskIds) props['Focus Tasks'] = brel(focusTaskIds);
  if (activeProjectIds) props['Active Projects'] = brel(activeProjectIds);
  const page = await nfetch('PATCH', `/pages/${id}`, { properties: props });
  return mapWeeklyPlan(page);
}

// ── Main handler ──

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { resource, id, project } = req.query;
  const method = req.method;

  try {
    let result;
    if (resource === 'projects') {
      if (method === 'GET') result = await getProjects();
      else if (method === 'POST') result = await upsertProject(req.body);
    } else if (resource === 'pm') {
      if (method === 'GET') result = await getPM(project);
    } else if (resource === 'tasks') {
      if (method === 'POST') result = await createTask(req.body);
      else if (method === 'PATCH') result = await updateTask(id, req.body);
      else if (method === 'DELETE') result = await archivePage(id);
    } else if (resource === 'milestones') {
      if (method === 'POST') result = await createMilestone(req.body);
      else if (method === 'PATCH') result = await updateMilestone(id, req.body);
      else if (method === 'DELETE') result = await archivePage(id);
    } else if (resource === 'weekly') {
      if (method === 'GET') result = await getOrCreateWeeklyPlan(req.query.weekStart);
      else if (method === 'PATCH') result = await updateWeeklyPlan(id, req.body);
    } else {
      res.status(400).json({ error: 'unknown resource' }); return;
    }
    if (result === undefined) { res.status(405).json({ error: 'method not allowed' }); return; }
    res.status(200).json(result);
  } catch (err) {
    console.error('[notion proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
};

const express = require('express');
const axios = require('axios');
const moment = require('moment');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Middleware: Jira Authentication & Setup ---
// Extracts headers and creates a configured Axios instance for the request
const jiraAuthMiddleware = (req, res, next) => {
    const jiraUrl = req.header('x-jira-url');
    const email = req.header('x-jira-email');
    const apiKey = req.header('x-jira-api-key');

    if (!jiraUrl || !email || !apiKey) {
        return res.status(400).json({
            error: 'Missing authentication headers. Please provide x-jira-url, x-jira-email, and x-jira-api-key.'
        });
    }

    // Clean trailing slash from URL if present
    const baseUrl = jiraUrl.replace(/\/$/, '');

    // Create axios instance attached to request object
    req.jiraClient = axios.create({
        baseURL: baseUrl,
        headers: {
            'Accept': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`
        }
    });

    next();
};

app.use(jiraAuthMiddleware);

// --- Helper: JQL Builder ---
const getJql = (projectKey) => {
    return projectKey ? `project = "${projectKey}"` : '';
};

// --- ROUTE 1: List Projects ---
app.get('/api/projects', async (req, res) => {
    try {
        const response = await req.jiraClient.get('/rest/api/3/project');

        const projects = response.data.map(p => ({
            key: p.key,
            name: p.name,
            id: p.id,
            style: p.projectTypeKey
        }));

        res.json({ total: projects.length, projects });
    } catch (error) {
        res.status(error.response?.status || 500).json({ error: error.message, details: error.response?.data });
    }
});

// --- ROUTE 2: Data Understanding ---
app.get('/api/data-understanding', async (req, res) => {
    try {
        const { projectKey, startAt = 0, maxResults = 50 } = req.query;

        if (!projectKey) return res.status(400).json({ error: "projectKey query parameter is required" });

        const jql = getJql(projectKey);

        // Fetch issues with specific fields
        const response = await req.jiraClient.post('/rest/api/3/search', {
            jql,
            startAt: parseInt(startAt),
            maxResults: parseInt(maxResults),
            fields: ['issuetype', 'status', 'priority', 'assignee', 'project']
        });

        const issues = response.data.issues;

        // Analysis Logic
        const analysis = {
            total_issues_in_batch: issues.length,
            total_matches_in_jira: response.data.total,
            groups: {
                by_type: {},
                by_status: {},
                by_priority: {},
                by_assignee: {}
            },
            data_quality: {
                missing_assignee: 0,
                missing_priority: 0
            }
        };

        issues.forEach(issue => {
            const f = issue.fields;

            // Grouping counts
            const type = f.issuetype?.name || 'Unknown';
            const status = f.status?.name || 'Unknown';
            const priority = f.priority?.name || 'None';
            const assignee = f.assignee?.displayName || 'Unassigned';

            analysis.groups.by_type[type] = (analysis.groups.by_type[type] || 0) + 1;
            analysis.groups.by_status[status] = (analysis.groups.by_status[status] || 0) + 1;
            analysis.groups.by_priority[priority] = (analysis.groups.by_priority[priority] || 0) + 1;
            analysis.groups.by_assignee[assignee] = (analysis.groups.by_assignee[assignee] || 0) + 1;

            // Missing fields detection
            if (!f.assignee) analysis.data_quality.missing_assignee++;
            if (!f.priority) analysis.data_quality.missing_priority++;
        });

        res.json(analysis);

    } catch (error) {
        console.error(error);
        res.status(error.response?.status || 500).json({ error: error.message, details: error.response?.data });
    }
});

// --- ROUTE 3: Time-Based Analysis ---
app.get('/api/time-analysis', async (req, res) => {
    try {
        const { projectKey, startAt = 0, maxResults = 50 } = req.query;
        // Get stalled days from header, default to 14
        const stalledLimitDays = parseInt(req.header('x-stalled-days')) || 14;

        if (!projectKey) return res.status(400).json({ error: "projectKey query parameter is required" });

        const response = await req.jiraClient.post('/rest/api/3/search', {
            jql: getJql(projectKey),
            startAt: parseInt(startAt),
            maxResults: parseInt(maxResults),
            fields: ['created', 'resolutiondate', 'updated', 'status']
        });

        const issues = response.data.issues;
        const now = moment();

        const stats = {
            config: { stalled_threshold_days: stalledLimitDays },
            averages: {
                avg_age_open_days: 0,
                avg_time_to_resolve_days: 0
            },
            issues_stalled: [],
            creation_spikes: { by_week: {} },
            resolution_spikes: { by_week: {} }
        };

        let totalOpenAge = 0;
        let openCount = 0;
        let totalResolutionTime = 0;
        let resolvedCount = 0;

        issues.forEach(issue => {
            const f = issue.fields;
            const created = moment(f.created);
            const updated = moment(f.updated);
            const resolved = f.resolutiondate ? moment(f.resolutiondate) : null;

            // 1. Spikes (Group by Week)
            const createdWeek = created.format('YYYY-WW');
            stats.creation_spikes.by_week[createdWeek] = (stats.creation_spikes.by_week[createdWeek] || 0) + 1;

            if (resolved) {
                // Resolved Metrics
                const resolvedWeek = resolved.format('YYYY-WW');
                stats.resolution_spikes.by_week[resolvedWeek] = (stats.resolution_spikes.by_week[resolvedWeek] || 0) + 1;

                const daysToResolve = resolved.diff(created, 'days');
                totalResolutionTime += daysToResolve;
                resolvedCount++;
            } else {
                // Open Metrics
                const age = now.diff(created, 'days');
                totalOpenAge += age;
                openCount++;

                // Stalled Detection (No updates in X days AND not resolved)
                const daysSinceUpdate = now.diff(updated, 'days');
                if (daysSinceUpdate >= stalledLimitDays) {
                    stats.issues_stalled.push({
                        key: issue.key,
                        status: f.status.name,
                        days_since_update: daysSinceUpdate
                    });
                }
            }
        });

        if (openCount > 0) stats.averages.avg_age_open_days = (totalOpenAge / openCount).toFixed(2);
        if (resolvedCount > 0) stats.averages.avg_time_to_resolve_days = (totalResolutionTime / resolvedCount).toFixed(2);

        res.json(stats);

    } catch (error) {
        res.status(error.response?.status || 500).json({ error: error.message, details: error.response?.data });
    }
});

// --- ROUTE 4: Workflow Analysis ---
app.get('/api/workflow-analysis', async (req, res) => {
    try {
        const { projectKey, startAt = 0, maxResults = 50 } = req.query;
        if (!projectKey) return res.status(400).json({ error: "projectKey query parameter is required" });

        // Request changelog to see history
        const response = await req.jiraClient.post('/rest/api/3/search', {
            jql: getJql(projectKey),
            startAt: parseInt(startAt),
            maxResults: parseInt(maxResults),
            expand: ['changelog'],
            fields: ['created', 'status']
        });

        const issues = response.data.issues;

        const analysis = {
            transitions: {}, // "To Do -> Done": 5
            status_time: {}, // "In Progress": { total_hours: 100, count: 5 }
            bottlenecks: [], // Calculated list
            reopen_patterns: [] // Issues that moved from Done -> To Do/In Progress
        };

        issues.forEach(issue => {
            const history = issue.changelog.histories;
            const created = moment(issue.fields.created);

            // Reconstruct timeline
            // We start with the creation date and the *initial* status (usually usually the first history item 'from' or defaults to To Do)
            // Note: Simplification applied here. We iterate history to find status changes.

            let lastTime = created;
            let currentStatus = "Open"; // Rough default, ideally implied from workflow

            // Histories are usually returned newest first, we need oldest first to calculate time forward
            const sortedHistory = history.sort((a, b) => new Date(a.created) - new Date(b.created));

            const seenStatuses = new Set();

            sortedHistory.forEach(changeGroup => {
                const changeTime = moment(changeGroup.created);

                changeGroup.items.forEach(item => {
                    if (item.field === 'status') {
                        const fromStatus = item.fromString;
                        const toStatus = item.toString;

                        // 1. Transition Counts
                        const transitionKey = `${fromStatus} -> ${toStatus}`;
                        analysis.transitions[transitionKey] = (analysis.transitions[transitionKey] || 0) + 1;

                        // 2. Time Spent in 'fromStatus'
                        const durationHours = changeTime.diff(lastTime, 'hours', true);

                        if (!analysis.status_time[fromStatus]) {
                            analysis.status_time[fromStatus] = { total_hours: 0, occurrences: 0 };
                        }
                        analysis.status_time[fromStatus].total_hours += durationHours;
                        analysis.status_time[fromStatus].occurrences++;

                        // 3. Reopen Detection (Back and Forth)
                        // If we see a status we've already seen in this issue's history, it's a back-and-forth
                        if (seenStatuses.has(toStatus)) {
                            // Simple heuristic: if we go back to a status we visited before
                            analysis.reopen_patterns.push({
                                key: issue.key,
                                pattern: `${fromStatus} -> ${toStatus} (Repeated)`
                            });
                        }

                        seenStatuses.add(fromStatus);
                        seenStatuses.add(toStatus);

                        // Update cursors
                        lastTime = changeTime;
                        currentStatus = toStatus;
                    }
                });
            });

            // Calculate time for the *current* status (from last change until Now)
            const durationCurrent = moment().diff(lastTime, 'hours', true);
            if (!analysis.status_time[currentStatus]) {
                analysis.status_time[currentStatus] = { total_hours: 0, occurrences: 0 };
            }
            analysis.status_time[currentStatus].total_hours += durationCurrent;
            analysis.status_time[currentStatus].occurrences++;
        });

        // Post-processing for bottlenecks (Statuses with highest avg time)
        const avgTimes = Object.keys(analysis.status_time).map(status => {
            const data = analysis.status_time[status];
            return {
                status,
                avg_hours: (data.total_hours / data.occurrences).toFixed(1)
            };
        });

        // Sort by longest time
        analysis.bottlenecks = avgTimes.sort((a, b) => parseFloat(b.avg_hours) - parseFloat(a.avg_hours));

        res.json(analysis);

    } catch (error) {
        console.error(error);
        res.status(error.response?.status || 500).json({ error: error.message, details: error.response?.data });
    }
});

app.listen(PORT, () => {
    console.log(`Jira Analytics Server running on port ${PORT}`);
});
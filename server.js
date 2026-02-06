const express = require('express');
const axios = require('axios');
const moment = require('moment');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Middleware: Jira Authentication & Setup ---
const jiraAuthMiddleware = (req, res, next) => {
    const jiraUrl = req.header('x-jira-url');
    const email = req.header('x-jira-email');
    const apiKey = req.header('x-jira-api-key');

    if (!jiraUrl || !email || !apiKey) {
        return res.status(400).json({
            error: 'Missing authentication headers. Please provide x-jira-url, x-jira-email, and x-jira-api-key.'
        });
    }

    const baseUrl = jiraUrl.replace(/\/$/, '');

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

// --- ROUTE 1: List Projects (Unchanged) ---
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
        const { projectKey, maxResults = 50, nextPageToken } = req.query;

        if (!projectKey) return res.status(400).json({ error: "projectKey query parameter is required" });

        // New Payload for /rest/api/3/search/jql
        const payload = {
            jql: getJql(projectKey),
            maxResults: parseInt(maxResults),
            fields: ['issuetype', 'status', 'priority', 'assignee', 'project'],
            // Add token if provided for pagination
            ...(nextPageToken && { nextPageToken })
        };

        // Updated Endpoint
        const response = await req.jiraClient.post('/rest/api/3/search/jql', payload);

        const issues = response.data.issues || [];

        const analysis = {
            total_issues_in_batch: issues.length,
            // The new API usually returns 'total' matching the JQL
            total_matches_in_jira: response.data.total,
            nextPageToken: response.data.nextPageToken || null, // Pass this back to client for next page
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
            const type = f.issuetype?.name || 'Unknown';
            const status = f.status?.name || 'Unknown';
            const priority = f.priority?.name || 'None';
            const assignee = f.assignee?.displayName || 'Unassigned';

            analysis.groups.by_type[type] = (analysis.groups.by_type[type] || 0) + 1;
            analysis.groups.by_status[status] = (analysis.groups.by_status[status] || 0) + 1;
            analysis.groups.by_priority[priority] = (analysis.groups.by_priority[priority] || 0) + 1;
            analysis.groups.by_assignee[assignee] = (analysis.groups.by_assignee[assignee] || 0) + 1;

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
        const { projectKey, maxResults = 50, nextPageToken } = req.query;
        const stalledLimitDays = parseInt(req.header('x-stalled-days')) || 14;

        if (!projectKey) return res.status(400).json({ error: "projectKey query parameter is required" });

        const payload = {
            jql: getJql(projectKey),
            maxResults: parseInt(maxResults),
            fields: ['created', 'resolutiondate', 'updated', 'status'],
            ...(nextPageToken && { nextPageToken })
        };

        const response = await req.jiraClient.post('/rest/api/3/search/jql', payload);

        const issues = response.data.issues || [];
        const now = moment();

        const stats = {
            config: { stalled_threshold_days: stalledLimitDays },
            nextPageToken: response.data.nextPageToken || null,
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

            const createdWeek = created.format('YYYY-WW');
            stats.creation_spikes.by_week[createdWeek] = (stats.creation_spikes.by_week[createdWeek] || 0) + 1;

            if (resolved) {
                const resolvedWeek = resolved.format('YYYY-WW');
                stats.resolution_spikes.by_week[resolvedWeek] = (stats.resolution_spikes.by_week[resolvedWeek] || 0) + 1;

                const daysToResolve = resolved.diff(created, 'days');
                totalResolutionTime += daysToResolve;
                resolvedCount++;
            } else {
                const age = now.diff(created, 'days');
                totalOpenAge += age;
                openCount++;

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
        const { projectKey, maxResults = 50, nextPageToken } = req.query;
        if (!projectKey) return res.status(400).json({ error: "projectKey query parameter is required" });

        // Step 1: Get Issue Keys using search/jql (It does NOT support expand)
        const payload = {
            jql: getJql(projectKey),
            maxResults: parseInt(maxResults),
            fields: ['key'], // Fetch minimal data first
            ...(nextPageToken && { nextPageToken })
        };

        const searchResponse = await req.jiraClient.post('/rest/api/3/search/jql', payload);
        const basicIssues = searchResponse.data.issues || [];

        // Step 2: Parallel Fetch of Changelogs using GET /issue/{key}
        // This endpoint DOES support expand=changelog
        const detailsPromises = basicIssues.map(async (basicIssue) => {
            try {
                const detailRes = await req.jiraClient.get(`/rest/api/3/issue/${basicIssue.key}`, {
                    params: {
                        fields: 'created,status',
                        expand: 'changelog'
                    }
                });
                return detailRes.data;
            } catch (err) {
                console.error(`Failed to fetch details for ${basicIssue.key}: ${err.message}`);
                return null;
            }
        });

        // Wait for all individual requests to finish
        const fullIssues = (await Promise.all(detailsPromises)).filter(i => i !== null);

        const analysis = {
            nextPageToken: searchResponse.data.nextPageToken || null,
            transitions: {},
            status_time: {},
            bottlenecks: [],
            reopen_patterns: []
        };

        fullIssues.forEach(issue => {
            // Changelog is now guaranteed to be present if the fetch succeeded
            const history = issue.changelog?.histories || [];
            const created = moment(issue.fields.created);

            let lastTime = created;
            let currentStatus = "Open";

            // Sort history oldest -> newest
            const sortedHistory = history.sort((a, b) => new Date(a.created) - new Date(b.created));
            const seenStatuses = new Set();

            sortedHistory.forEach(changeGroup => {
                const changeTime = moment(changeGroup.created);

                changeGroup.items.forEach(item => {
                    if (item.field === 'status') {
                        const fromStatus = item.fromString;
                        const toStatus = item.toString;
                        const transitionKey = `${fromStatus} -> ${toStatus}`;

                        analysis.transitions[transitionKey] = (analysis.transitions[transitionKey] || 0) + 1;

                        const durationHours = changeTime.diff(lastTime, 'hours', true);
                        if (!analysis.status_time[fromStatus]) {
                            analysis.status_time[fromStatus] = { total_hours: 0, occurrences: 0 };
                        }
                        analysis.status_time[fromStatus].total_hours += durationHours;
                        analysis.status_time[fromStatus].occurrences++;

                        if (seenStatuses.has(toStatus)) {
                            analysis.reopen_patterns.push({
                                key: issue.key,
                                pattern: `${fromStatus} -> ${toStatus} (Repeated)`
                            });
                        }

                        seenStatuses.add(fromStatus);
                        seenStatuses.add(toStatus);
                        lastTime = changeTime;
                        currentStatus = toStatus;
                    }
                });
            });

            // Calculate time for current status
            const durationCurrent = moment().diff(lastTime, 'hours', true);
            if (!analysis.status_time[currentStatus]) {
                analysis.status_time[currentStatus] = { total_hours: 0, occurrences: 0 };
            }
            analysis.status_time[currentStatus].total_hours += durationCurrent;
            analysis.status_time[currentStatus].occurrences++;
        });

        const avgTimes = Object.keys(analysis.status_time).map(status => {
            const data = analysis.status_time[status];
            return {
                status,
                avg_hours: (data.total_hours / data.occurrences).toFixed(1)
            };
        });

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
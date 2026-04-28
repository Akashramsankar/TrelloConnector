# Describe the idea
Build a Freshdesk app that allows agents to set a date and time to reopen a ticket. Agents can configure settings such as domain, API key, time zone, and exceptions for ticket statuses that should not be reopened. The app will be accessible from the sidebar in all tickets, where agents can choose or update the date and time for reopening the ticket. Additionally, it provides a dashboard to view all scheduled reopenings and sends an email notification to the agent upon reopening.


# Describe the app UI
The sidebar UI will include a date and time picker for agents to set or update the reopening schedule. The configuration settings page during installation will have fields for domain, API key, time zone, and exception statuses. The dashboard UI will list all scheduled reopenings with options to filter, search, and sort by date, time, or agent.


# List of core features
- Allow agents to set a date and time to reopen a ticket
- Provide settings for domain, API key, time zone, and exception statuses during installation
- App accessible from the sidebar of all tickets
- Option to update the timing
- Dashboard to view all scheduled reopenings
- Email notification to agent on reopen


# Future Considerations
- Integration with external calendars for reminders
- Analytics on ticket reopening patterns
- Mobile app support
- Role-based access control for dashboard



# Implementation Plan
## Describe the UI to be built for every placeholder
- Placeholder: ticket_sidebar in support_ticket
UI with date and time picker for agents to schedule ticket reopening, along with a cancel button for existing schedules.
- Placeholder: full_page_app in common
Dashboard showing all scheduled ticket reopenings with filter, search and sort options.


## Details on what and how to fetch installation parameters
Include installation parameters such as Freshdesk domain, API key, default time zone, and exception statuses that should not trigger ticket reopening. Since validating API key requires making an API call to Freshdesk, a custom installation page is needed.

## Ticket Sidebar Load: Register & Implement Sidebar UI
Create an event handler for app.activated to initialize the UI components including date/time picker, and fetch any existing reopen schedule for the current ticket using Freshdesk API.

## Schedule Reopen: Register & Implement Reopen Schedule Creation
Implement a click event handler for the submit button that validates the reopen time selected by the agent and stores it in Data Storage, then schedules the ticket reopen job.

## Dashboard Load: Register & Implement Dashboard UI
Implement the app.activated event handler in the full_page_app to retrieve all scheduled ticket reopenings from Data Storage and display them in a sortable/filterable table UI for easier management.

## Scheduled Reopen: Register & Implement Ticket Reopen
Implement onScheduledEvent handler to query Freshdesk API for all tickets due for reopening based on predefined criteria, then use Freshdesk API to update their status to 'Open' and send email notifications to assigned agents.

## File Structure
`app/scripts/app.js`: App Frontend Script
`manifest.json`: Contains the app manifest
`app/scripts/ticket_sidebar.js`
`config/iparams.html`: Custom Installation page for app parameters
`app/index.html`: Entry point for the app
`config/assets/iparams.js`: Custom Installation scripts page for app parameters
`server/server.js`: App Backend Script
`app/ticket_sidebar.html`
`config/requests.json`: Api Request Description

## Steps to run the app
- Run "fdk validate" and make sure no errors are there
- Fix errors if any (can use copilot to fix (lint))
- Run "fdk run"
- Go to "http://localhost:3001" for iparams
- Go to "...?dev=true"

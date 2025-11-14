#!/bin/bash
set -e

FILE="src/index.ts"

# Add validation to handleListMessages - insert after the second line of the method
perl -i -p0e 's/(private async handleListMessages\(args: ListMessagesArgs\) \{\n    const \{ agent, limit = DEFAULT_PAGE_LIMIT, offset = 0 \} = args;\n\n    const messageList)/$1\n\n    \/\/ Validate agent name if provided\n    if (agent) {\n      this.validateAgentName(agent);\n    }\n/s' "$FILE" 2>/dev/null || sed -i '/private async handleListMessages(args: ListMessagesArgs) {/{
n
n
a\
\    // Validate agent name if provided\
\    if (agent) {\
\      this.validateAgentName(agent);\
\    }\
\
}' "$FILE"

# Add validation to handleClearMessages
perl -i -p0e 's/(private async handleClearMessages\(args: ClearMessagesArgs\) \{\n    const \{ agent \} = args;\n    let deletedCount = 0;\n\n    if \(agent\) \{)/$1\n\n    \/\/ Validate agent name if provided\n    if (agent) {\n      this.validateAgentName(agent);\n    }\n/s' "$FILE" 2>/dev/null || sed -i '/private async handleClearMessages(args: ClearMessagesArgs) {/{
n
n
n
a\
\    // Validate agent name if provided\
\    if (agent) {\
\      this.validateAgentName(agent);\
\    }\
\
}' "$FILE"

# Add validation to handleGetAgentStats
perl -i -p0e 's/(private async handleGetAgentStats\(args: GetAgentStatsArgs\) \{\n    const \{ agent \} = args;\n\n    if \(agent\) \{)/$1\n\n    \/\/ Validate agent name if provided\n    if (agent) {\n      this.validateAgentName(agent);\n    }\n/s' "$FILE" 2>/dev/null || sed -i '/private async handleGetAgentStats(args: GetAgentStatsArgs) {/{
n
n
a\
\    // Validate agent name if provided\
\    if (agent) {\
\      this.validateAgentName(agent);\
\    }\
\
}' "$FILE"

# Add validation to handleGetActivityStats
perl -i -p0e 's/(private async handleGetActivityStats\(args: GetActivityStatsArgs\) \{\n    const \{ start_date, end_date, agent \} = args;\n\n    let dailyActivity)/$1\n\n    \/\/ Validate agent name if provided\n    if (agent) {\n      this.validateAgentName(agent);\n    }\n/s' "$FILE" 2>/dev/null || sed -i '/private async handleGetActivityStats(args: GetActivityStatsArgs) {/{
n
n
a\
\    // Validate agent name if provided\
\    if (agent) {\
\      this.validateAgentName(agent);\
\    }\
\
}' "$FILE"

echo "Missing validations added!"

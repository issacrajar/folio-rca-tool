# Query Approval Modal Feature

**Date**: June 3, 2026
**Purpose**: Show users MongoDB and other queries for review and approval before executing them, with the ability to edit queries inline

## Overview

The Query Approval Modal provides a safety mechanism for executing database queries. Before running any query against MongoDB or other backends, the system will:

1. Generate the query
2. Display it in a modal dialog
3. Allow the user to review it
4. Allow the user to edit it (optional)
5. Execute only after user approval

This feature prevents accidental data modifications and allows users to understand exactly what queries are being run.

## Features

### ✅ Query Preview
- Display generated queries in a formatted, readable way
- Support for both JSON and string query formats
- Pretty-printed JSON with 2-space indentation

### ✅ Editable Queries
- Users can modify queries before execution
- Edit field is a large textarea for easy viewing and editing
- Changes are used for the actual execution

### ✅ User-Friendly Interface
- Modal dialog with clear messaging
- "Approve & Execute" button to run the query
- "Cancel" button to abort the operation
- ESC key support to close modal
- Helpful tips and warnings

### ✅ Flexible Integration
- `showQueryApproval()` function for generic queries
- `executeMongoQueryWithApproval()` for MongoDB operations
- Can be integrated with any other query types

## Usage

### Basic Integration

```javascript
// Show query approval modal
showQueryApproval(
  'Generate MongoDB Query - Review & Approve',  // Message
  queryObject,                                   // Query to display
  async (approvedQuery) => {                    // Callback on approval
    // Execute with approved query
    const result = await executeQuery(approvedQuery);
    handleResult(result);
  }
);
```

### MongoDB Execution

```javascript
// Execute with approval
executeMongoQueryWithApproval(
  folioTransactions,  // Input data
  (mongoData) => {    // Success callback
    // Process results
    renderResults(mongoData);
  }
);
```

## API

### `showQueryApproval(message, query, callback)`

**Parameters**:
- `message` (string): Description of what the query does
- `query` (object|string): The query to display
- `callback` (function): Called with approved (or edited) query

**Behavior**:
- Displays modal with query
- User can edit the query in textarea
- On approval, calls callback with edited or original query
- Closes modal and passes control to callback

### `closeQueryApproval()`

**Closes** the query approval modal without executing anything.

### `approveQueryExecution()`

**Called internally** when user clicks "Approve & Execute" button.
- Retrieves edited query from textarea
- Parses JSON if applicable
- Calls the pending callback with the query
- Closes modal

### `executeMongoQueryWithApproval(folioTransactions, onSuccess)`

**Convenience function** for MongoDB queries.
- Generates query using `/api/generate-mongo-query`
- Shows approval modal
- On approval, executes with `/api/execute-mongo-query`
- Calls `onSuccess` with results

## Modal Interface

### Elements

**Header**:
- Title: "🔐 Query Approval Required"
- Close button (X)

**Content**:
- Message about what query is running
- Large editable textarea with the query
- Instructions: "You can edit the query above before execution..."

**Buttons**:
- ✅ "Approve & Execute" (green) - Accept and run
- ❌ "Cancel" (red) - Reject and abort

### Keyboard Shortcuts

- **ESC**: Close modal without executing
- **Tab**: Navigate between elements
- **Ctrl+Enter** in textarea: Could be added for quick approval (not yet implemented)

## Examples

### Example 1: Simple MongoDB Query

```javascript
const res = await fetch(`${API}/api/generate-mongo-query`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folioTransactions })
});

const data = await res.json();
const queryObj = JSON.parse(data.mongoAggregationQuery);

showQueryApproval(
  '🔐 MongoDB Ledger Query - Review Before Execution',
  queryObj,
  async (approvedQuery) => {
    // Execute with approved query
    const result = await fetch(`${API}/api/execute-mongo-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        folioTransactions,
        customQuery: approvedQuery
      })
    });
    
    const resultData = await result.json();
    if (resultData.error) {
      toast('Error: ' + resultData.error);
      return;
    }
    
    // Process results
    renderResults(resultData);
  }
);
```

### Example 2: Using Convenience Function

```javascript
executeMongoQueryWithApproval(
  folioTransactions,
  (mongoData) => {
    // This is called after user approves
    toast(`Fetched ${mongoData.rowCount} rows from MongoDB`);
    
    // Run comparison
    runComparison(mongoData.rows, folioTransactions);
  }
);
```

## State Management

### Global Variables (in app.js)

```javascript
let pendingQuery = null;           // The query awaiting approval
let pendingQueryCallback = null;   // Function to call on approval
let pendingQueryMessage = '';      // Description message
```

These are reset when modal is closed or query is executed.

## Modal Styling

The modal uses the existing CSS custom properties from the RCA tool:

```css
--bg: #1e1e2e              /* Dark background */
--surface: #282840         /* Modal background */
--border: #3a3a5c          /* Border color */
--text: #cdd6f4            /* Text color */
--accent: #89b4fa          /* Accent color */
--green: #a6e3a1           /* Approve button */
--red: #f38ba8             /* Cancel button */
```

## Security Considerations

### ✅ What This Helps With:
- Prevents accidental unintended queries
- Shows exactly what will be executed
- User can review and modify before execution
- Reduces risk of automated query mistakes

### ⚠️ What This Does NOT Do:
- Does NOT authenticate users (authentication is separate)
- Does NOT validate query syntax (relies on backend)
- Does NOT prevent malicious users from editing queries (user owns editing)
- Does NOT prevent all mistakes (user can still approve bad queries)

## Future Enhancements

Possible improvements for future versions:

1. **Query Validation**: Show validation errors before execution
2. **Query Suggestions**: Highlight suspicious changes or patterns
3. **Query History**: Show previous similar queries for reference
4. **Dry Run**: Option to do a dry-run before actual execution
5. **Keyboard Shortcut**: Ctrl+Enter in textarea to approve
6. **Query Syntax Highlighting**: Syntax highlighting in textarea
7. **Query Diff**: Show what was changed from original to edited
8. **Confirmation Dialog**: Double-confirm for risky operations

## Troubleshooting

### Modal Doesn't Appear

**Problem**: Clicking button doesn't show modal
**Solution**: Check that `showQueryApproval()` is being called with valid parameters

### Query Not Executing After Approval

**Problem**: Modal closes but query doesn't run
**Solution**: Check console for errors in the callback function

### Modal Stuck Open

**Problem**: Modal won't close
**Solution**: Press ESC key, or check console for JavaScript errors

### JSON Parse Error

**Problem**: "Invalid JSON" error when editing
**Solution**: 
- Ensure your edited query is valid JSON
- If it's not JSON (e.g., MongoDB shell syntax), keep it as text
- The system will auto-detect and handle both

## Integration Points

The Query Approval Modal can be integrated at these points:

1. **MongoDB Ledger Fetch** - When building comparison
2. **GraphQL Queries** - When fetching resend data
3. **User Mongo Queries** - When running custom queries
4. **Transfer Analysis Queries** - When validating transfers
5. **Any other API call** - That needs user review

Current implementations:
- ✅ `executeMongoQueryWithApproval()` for MongoDB
- ⏳ Other query types can follow similar pattern

## Files Modified

- `client/index.html` - Added modal HTML
- `client/app.js` - Added modal functions (showQueryApproval, approveQueryExecution, closeQueryApproval)

## Testing

To test the feature:

1. Go to "Mongo Query" tab
2. Paste folio data
3. Click "Execute Mongo Query"  
4. Modal should appear with the aggregation query
5. Optionally edit the query
6. Click "Approve & Execute"
7. Query runs with the approved (or edited) version

---

**Status**: ✅ Complete
**Date**: June 3, 2026
**Version**: 1.0.0


# Transfer Validation Feature - Deployment Guide

This guide covers deployment of the Transfer Identification Feature (Phases 10-18).

## Pre-Deployment Checklist

### Code Quality
- [ ] All TypeScript files compile without errors
- [ ] All lint checks passing
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Performance tests passing (< 10ms per transfer)
- [ ] No unused imports or variables
- [ ] All functions documented with JSDoc

### Testing
- [ ] Test with Case 1 scenarios (simple matching)
- [ ] Test with Case 2 scenarios (tax-based matching)
- [ ] Test with mixed payload (successful + failed + unmatched)
- [ ] Test with large payloads (1000+ transfers)
- [ ] Test error handling (null inputs, invalid JSON, etc.)
- [ ] Test edge cases (whitespace, circular refs, etc.)

### Configuration
- [ ] `.env` file configured for target environment
- [ ] Log levels set appropriately
- [ ] Timeout values realistic for expected payload sizes
- [ ] Metrics collection enabled if applicable
- [ ] Feature flags reviewed and set appropriately

### Documentation
- [ ] `TRANSFER_VALIDATION_GUIDE.md` reviewed
- [ ] `TRANSFER_IMPLEMENTATION_SUMMARY.md` reviewed
- [ ] Configuration documentation reviewed
- [ ] README updated with new features
- [ ] Team trained on new feature

### Database
- [ ] MongoDB indexes created for fast transfer queries
- [ ] Indexes: `folioTransactionDetails._id`, `folioTransactionDetails.itemId`
- [ ] Verified query performance

### Monitoring
- [ ] Prometheus metrics configured (if enabled)
- [ ] Log aggregation configured
- [ ] Dashboards created
- [ ] Alert thresholds set

## Deployment Steps

### 1. Dependency Installation

```bash
# Install the tool if not already done
cd tools/folio-rca-tool
npm install

# Verify all dependencies resolved
npm list
```

### 2. Configuration Setup

```bash
# Copy example configuration
cp .env.example.transfer .env

# Edit for your environment
vim .env

# Verify critical settings
echo $ENABLE_TRANSFER_VALIDATION
echo $TRANSFER_VALIDATION_TIMEOUT
echo $TRANSFER_LOG_LEVEL
```

### 3. Database Preparation

```bash
# Create MongoDB indexes for performance
mongo
use your_database
db.folios.createIndex({ "folioTransactionDetails.folioTransferDetails": 1 });
db.folios.createIndex({ "folioTransactionDetails._id": 1 });
db.folios.createIndex({ "folioTransactionDetails.itemId": 1 });
db.folios.createIndex({ "createdAt": 1 });
```

### 4. Build & Compile

```bash
# TypeScript compilation
npm run build

# Check for compilation errors
npm run tsc -- --noEmit

# Lint check
npm run lint
```

### 5. Test Execution

```bash
# Run unit tests
npm test

# Run integration tests with test data
npm run test:integration

# Run performance tests
npm run test:perf

# Check test coverage
npm run test:coverage
```

### 6. Server Start

```bash
# Start the RCA tool server
npm run rca-tool

# Server should be available at http://localhost:3999
# Check logs for startup messages
```

### 7. Smoke Testing

```bash
# Test API endpoints manually
curl -X POST http://localhost:3999/api/validate-transfers \
  -H "Content-Type: application/json" \
  -d '{
    "payload": [{"folioId":"TEST","folioTransactionDetails":[]}],
    "options":{"verboseTraces":false}
  }'

# Should return 200 with success: true
```

### 8. UI Accessibility

```bash
# Open in browser
open http://localhost:3999

# Navigate to "🔗 Transfer Analysis" tab
# Verify all panels load correctly
# Test with sample data from fixtures
```

## Rollback Procedure

If deployment fails or issues are discovered:

### Immediate Rollback
1. Stop the server
2. Revert to previous version from git
3. Rebuild and restart
4. Verify previous features still work

```bash
# Stop server (Ctrl+C or)
kill $(lsof -t -i:3999)

# Revert code
git checkout HEAD~1

# Rebuild
npm install
npm run build

# Restart
npm run rca-tool
```

### Data Rollback
- Transfer validation doesn't modify data, only reads and validates
- No rollback needed unless database changes were made
- If MongoDB indexes were created, they can be dropped if needed:
  ```bash
  db.folios.dropIndex("folioTransactionDetails.folioTransferDetails_1")
  ```

## Post-Deployment Validation

### Functionality Tests

```typescript
// Test 1: Simple Case 1 Match
POST /api/validate-transfers
{
  "payload": [{
    "folioId": "TEST_001",
    "folioTransactionDetails": [{
      "_id": "LINE_001",
      "itemId": "ITEM_001",
      "refundReferenceId": "REF_001",
      "folioTransferDetails": [{"trnsfrFromLineItemNo": "REF_001"}]
    }]
  }],
  "options": {}
}
// Expected: status 200, successful[0].matched = true
```

```typescript
// Test 2: Failed Match (Unmatched)
POST /api/validate-transfers
{
  "payload": [{
    "folioId": "TEST_002",
    "folioTransactionDetails": [{
      "_id": "LINE_002",
      "itemId": "ITEM_002",
      "adjustmentReferenceId": null,
      "folioTransferDetails": [{"trnsfrFromLineItemNo": "NONEXISTENT"}]
    }]
  }],
  "options": {}
}
// Expected: status 200, unmatched[0].matched = false
```

### Performance Baseline

```bash
# Run performance test and record baseline
npm run test:perf > perf-baseline.txt

# Monitor metrics
# - Single transfer: < 5ms
# - 100 transfers: < 500ms
# - 1000 transfers: < 5s
```

### Load Testing

```bash
# Test with realistic payload size
# Generate test payload with 500+ transfers
# Measure response time and resource usage

npm run test:load -- --transfers 500 --concurrent 5
```

### Error Handling

```typescript
// Test error case: Invalid JSON
POST /api/validate-transfers
Content-Type: application/json

{invalid json}

// Expected: status 400, error message provided
```

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Validation Success Rate**
   - Target: > 95%
   - Alert if drops below 90%

2. **Average Validation Time**
   - Target: < 3ms per transfer
   - Alert if exceeds 10ms

3. **Error Rate by Type**
   - Monitor: TAX_REF_NOT_FOUND, NO_MATCH, etc.
   - Alert on sudden increase

4. **API Response Times**
   - POST /api/validate-transfers: < 2s for 100 transfers
   - POST /api/validate-transfer-line: < 50ms
   - POST /api/trace-transfer-reference: < 100ms

### Prometheus Queries (if metrics enabled)

```promql
# Success rate
rate(transfer_validation_total{status="success"}[5m]) / rate(transfer_validation_total[5m])

# P95 latency
histogram_quantile(0.95, transfer_validation_duration_ms)

# Error rate
rate(transfer_validation_total{status!="success"}[5m])
```

### Log Monitoring

```bash
# Watch for errors
tail -f logs/transfer-validation.log | grep ERROR

# Monitor performance warnings
tail -f logs/transfer-validation.log | grep "WARN.*duration"

# Count by error type
grep ERROR logs/transfer-validation.log | cut -d'|' -f2 | sort | uniq -c
```

## Version Management

### Semantic Versioning

The Transfer Validation Feature follows semantic versioning:
- **Major (1.x.x)**: Breaking API changes
- **Minor (x.1.x)**: New features, backward compatible
- **Patch (x.x.1)**: Bug fixes

Current version: **1.0.0** (June 3, 2026)

### Version Bump Checklist

When releasing a new version:
- [ ] Update `package.json` version
- [ ] Update `CHANGELOG.md`
- [ ] Tag Git commit with version
- [ ] Update documentation if needed
- [ ] Verify all tests passing

## Documentation Updates

After deployment, update:

1. **Internal Wiki/Confluence**
   - How to use Transfer Analysis tab
   - API endpoint documentation
   - Troubleshooting guide

2. **Team Knowledge Base**
   - Common issues and solutions
   - Example payloads for testing
   - FAQ

3. **Runbook**
   - How to monitor
   - How to troubleshoot
   - Escalation procedures

## Support & Troubleshooting

### Common Issues

**Issue**: Validation endpoint returns 503 (Service Unavailable)
- **Cause**: Feature disabled via `ENABLE_TRANSFER_VALIDATION=false`
- **Solution**: Check environment variables, enable feature

**Issue**: Timeout errors on large payloads
- **Cause**: `TRANSFER_VALIDATION_TIMEOUT` too small
- **Solution**: Increase timeout, test with actual payload sizes

**Issue**: MongoDB query errors
- **Cause**: Missing indexes
- **Solution**: Create indexes as per Database Preparation section

**Issue**: High memory usage
- **Cause**: Processing very large payloads
- **Solution**: Set `TRANSFER_MAX_TRANSFERS` limit, split payloads

### Getting Help

1. Check `TRANSFER_VALIDATION_GUIDE.md`
2. Review logs with appropriate log level
3. Test with sample data from fixtures
4. Use debug endpoints for single transfer testing
5. Contact DevOps team for infrastructure issues

## Maintenance Schedule

### Daily
- Monitor error rates and success rates
- Check logs for unexpected errors
- Verify API response times

### Weekly
- Review performance metrics
- Check disk usage (logs, data)
- Verify backups completed

### Monthly
- Review and update documentation
- Check for pending updates/patches
- Test rollback procedure
- Review security considerations

### Quarterly
- Major version assessment
- Performance tuning review
- Capacity planning
- Security audit

## Security Considerations

### Data Protection
- Transfer validation doesn't store user data
- Folio data is not persisted
- Logs may contain sensitive data - configure accordingly

### Access Control
- Restrict RCA tool access to authorized users only
- Use VPN/firewall if exposed to network
- Implement HTTP authentication if needed

### API Security
- No authentication currently required
- Recommend adding before production exposure
- Validate input payload size

### Monitoring & Compliance
- Audit logs for access
- Monitor for suspicious patterns
- Comply with data retention policies

## Success Criteria

Deployment is successful if:

✅ All API endpoints responding correctly
✅ UI accessible and functional
✅ Sample tests passing
✅ Performance within acceptable range (< 10ms per transfer)
✅ Error handling working as expected
✅ Monitoring and alerts configured
✅ Team trained and comfortable with feature
✅ Documentation complete and accessible
✅ No blocking issues found during testing

## Post-Deployment Support Window

- **24-hour support**: Immediate response for critical issues
- **7-day monitoring**: Enhanced monitoring period
- **30-day stabilization**: Standard support resumes

---

**Last Updated**: June 3, 2026
**Version**: 1.0.0


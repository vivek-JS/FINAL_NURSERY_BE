# AWS Lambda Deployment Guide for Nursery Management API

## Prerequisites

1. **AWS Account**: You need an AWS account with appropriate permissions
2. **Node.js**: Version 18.x or higher
3. **AWS CLI**: Install and configure with your credentials
4. **Serverless Framework**: Install globally

## Step 1: Install Dependencies

```bash
# Install serverless framework globally
npm install -g serverless

# Install project dependencies
npm install

# Install dev dependencies
npm install --save-dev serverless serverless-offline
```

## Step 2: Configure Environment Variables

1. Copy the example environment file:
```bash
cp env.lambda.example .env
```

2. Update `.env` with your actual values:
   - `MONGO_URL`: Your MongoDB connection string
   - `JWT_SECRET`: A strong secret key for JWT tokens
   - `ALLOWED_ORIGINS`: Comma-separated list of allowed frontend domains

## Step 3: Configure AWS Credentials

```bash
# Configure AWS CLI
aws configure

# Or set environment variables
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_DEFAULT_REGION=us-east-1
```

## Step 4: Test Locally (Optional)

```bash
# Test with serverless offline
npm run offline

# Or test traditional server
npm run dev
```

## Step 5: Deploy to AWS Lambda

### Deploy to Development Stage
```bash
npm run deploy
```

### Deploy to Production Stage
```bash
npm run deploy:prod
```

### Deploy to Staging Stage
```bash
npm run deploy:staging
```

## Step 6: Verify Deployment

After deployment, you'll see output like:
```
endpoints:
  ANY - https://abc123.execute-api.us-east-1.amazonaws.com/dev/
  ANY - https://abc123.execute-api.us-east-1.amazonaws.com/dev/{proxy+}
```

Test your API:
```bash
curl https://abc123.execute-api.us-east-1.amazonaws.com/dev/
```

## Step 7: Update Frontend Configuration

Update your frontend API base URL to point to the new Lambda endpoint:

```javascript
// Example for React app
const API_BASE_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/dev';
```

## Environment Variables in AWS

You can set environment variables in the AWS Console:

1. Go to AWS Lambda Console
2. Select your function
3. Go to Configuration → Environment Variables
4. Add your variables:
   - `MONGO_URL`
   - `JWT_SECRET`
   - `ALLOWED_ORIGINS`
   - `NODE_ENV=production`

## Security Considerations

1. **API Gateway**: Configure authentication if needed
2. **CORS**: Update `ALLOWED_ORIGINS` with your frontend domains
3. **Environment Variables**: Use AWS Secrets Manager for sensitive data
4. **VPC**: Consider placing Lambda in VPC if connecting to private resources

## Monitoring and Logs

- **CloudWatch Logs**: View function logs in AWS Console
- **CloudWatch Metrics**: Monitor performance and errors
- **X-Ray**: Enable for detailed tracing

## Cost Optimization

- **Memory**: Adjust memory allocation based on usage (128MB-3008MB)
- **Timeout**: Set appropriate timeout values
- **Provisioned Concurrency**: For consistent performance

## Troubleshooting

### Common Issues:

1. **Cold Start**: First request may be slow
2. **Memory Issues**: Increase memory allocation
3. **Timeout**: Increase timeout for long-running operations
4. **CORS Errors**: Check `ALLOWED_ORIGINS` configuration

### Useful Commands:

```bash
# View logs
serverless logs -f app

# Remove deployment
npm run remove

# Deploy specific function
serverless deploy function -f app
```

## API Endpoints

Your API will be available at:
- Base URL: `https://[api-id].execute-api.us-east-1.amazonaws.com/dev`
- Health Check: `GET /health`
- API Routes: `GET /api/v1/*`

## Support

For issues:
1. Check CloudWatch logs
2. Verify environment variables
3. Test locally with `npm run offline`
4. Check AWS Lambda console for errors 
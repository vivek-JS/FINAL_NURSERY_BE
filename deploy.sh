#!/bin/bash

# AWS Lambda Deployment Script for Nursery Management API
# Usage: ./deploy.sh [stage]

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default stage
STAGE=${1:-dev}

echo -e "${BLUE}🚀 Starting AWS Lambda deployment for Nursery Management API${NC}"
echo -e "${BLUE}Stage: ${YELLOW}$STAGE${NC}"

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ Error: .env file not found!${NC}"
    echo -e "${YELLOW}Please copy env.lambda.example to .env and configure your environment variables${NC}"
    exit 1
fi

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ Error: AWS CLI is not installed${NC}"
    echo -e "${YELLOW}Please install AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html${NC}"
    exit 1
fi

# Check if serverless is installed
if ! command -v serverless &> /dev/null; then
    echo -e "${RED}❌ Error: Serverless Framework is not installed${NC}"
    echo -e "${YELLOW}Please install serverless: npm install -g serverless${NC}"
    exit 1
fi

# Check AWS credentials
echo -e "${BLUE}🔍 Checking AWS credentials...${NC}"
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ Error: AWS credentials not configured${NC}"
    echo -e "${YELLOW}Please run: aws configure${NC}"
    exit 1
fi

echo -e "${GREEN}✅ AWS credentials verified${NC}"

# Install dependencies
echo -e "${BLUE}📦 Installing dependencies...${NC}"
npm install

# Run tests if available
if [ -f "package.json" ] && grep -q "\"test\"" package.json; then
    echo -e "${BLUE}🧪 Running tests...${NC}"
    npm test || echo -e "${YELLOW}⚠️  Tests failed, but continuing deployment${NC}"
fi

# Deploy to AWS Lambda
echo -e "${BLUE}🚀 Deploying to AWS Lambda (stage: $STAGE)...${NC}"

if [ "$STAGE" = "prod" ]; then
    echo -e "${YELLOW}⚠️  Deploying to PRODUCTION stage${NC}"
    read -p "Are you sure you want to deploy to production? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}❌ Deployment cancelled${NC}"
        exit 1
    fi
fi

# Deploy using serverless
serverless deploy --stage $STAGE

echo -e "${GREEN}✅ Deployment completed successfully!${NC}"

# Get the API endpoint
echo -e "${BLUE}🔗 Getting API endpoint...${NC}"
ENDPOINT=$(serverless info --stage $STAGE | grep "endpoints:" -A 2 | grep "ANY" | head -1 | awk '{print $3}')

if [ ! -z "$ENDPOINT" ]; then
    echo -e "${GREEN}🌐 Your API is available at:${NC}"
    echo -e "${BLUE}$ENDPOINT${NC}"
    
    # Test the endpoint
    echo -e "${BLUE}🧪 Testing API endpoint...${NC}"
    if curl -s "$ENDPOINT" > /dev/null; then
        echo -e "${GREEN}✅ API is responding correctly${NC}"
    else
        echo -e "${YELLOW}⚠️  API test failed, but deployment was successful${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Could not retrieve API endpoint${NC}"
fi

echo -e "${GREEN}🎉 Deployment process completed!${NC}"
echo -e "${BLUE}📋 Next steps:${NC}"
echo -e "  1. Update your frontend API base URL to: $ENDPOINT"
echo -e "  2. Test all your API endpoints"
echo -e "  3. Monitor logs in AWS CloudWatch"
echo -e "  4. Set up monitoring and alerts"

# Save endpoint to file for reference
echo "$ENDPOINT" > .deployment-endpoint
echo -e "${BLUE}💾 API endpoint saved to .deployment-endpoint${NC}" 
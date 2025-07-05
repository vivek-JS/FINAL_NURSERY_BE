# 🚀 AWS Cost Optimization Deployment - Step by Step Guide

## 📋 Prerequisites Checklist

Before starting, ensure you have:

- [ ] AWS account (preferably new for Free Tier eligibility)
- [ ] AWS CLI installed and configured
- [ ] Terraform installed (version 1.0+)
- [ ] Domain name registered
- [ ] Git repository cloned locally

## 🎯 Step 1: AWS Account Setup & Free Tier Verification

### 1.1 Create AWS Account (if needed)
```bash
# Visit AWS Free Tier page
open https://aws.amazon.com/free/

# Sign up for new account with:
# - Valid email address
# - Credit card for verification
# - Strong password
```

### 1.2 Install and Configure AWS CLI
```bash
# Install AWS CLI (macOS)
brew install awscli

# Install AWS CLI (Ubuntu)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Configure AWS CLI
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter your default region (us-east-1)
# Enter your output format (json)
```

### 1.3 Verify AWS Credentials
```bash
# Test AWS credentials
aws sts get-caller-identity

# Expected output:
# {
#   "UserId": "AIDA...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/your-username"
# }
```

### 1.4 Check Free Tier Eligibility
```bash
# Check account creation date
aws iam get-user --query 'User.CreateDate' --output text

# If account is less than 365 days old, you're eligible for Free Tier
# If older, you'll still get cost savings but not Free Tier benefits
```

## 🏗️ Step 2: Install Required Tools

### 2.1 Install Terraform
```bash
# Install Terraform (macOS)
brew install terraform

# Install Terraform (Ubuntu)
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add -
sudo apt-add-repository "deb [arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs)"
sudo apt-get update && sudo apt-get install terraform

# Verify installation
terraform --version
```

### 2.2 Install Additional Tools
```bash
# Install jq for JSON processing
brew install jq  # macOS
sudo apt install jq  # Ubuntu

# Install curl (usually pre-installed)
curl --version
```

## 🔧 Step 3: Project Setup

### 3.1 Navigate to Project Directory
```bash
# Navigate to your project root
cd /path/to/your/nursery-project

# Verify you're in the correct directory
ls -la
# Should see: app.js, package.json, deployment/ folder, etc.
```

### 3.2 Set Up Cost-Optimized Configuration
```bash
# Navigate to AWS deployment directory
cd deployment/aws/terraform

# Copy cost-optimized configuration
cp terraform.tfvars.cost-optimized.example terraform.tfvars

# Edit configuration with your settings
nano terraform.tfvars
```

### 3.3 Configure Your Settings
Edit `terraform.tfvars` with your specific values:

```hcl
# AWS Configuration
aws_region = "us-east-1"
environment = "production"
project_name = "nursery-backend"

# Domain Configuration
domain_name = "your-nursery-domain.com"  # Replace with your domain

# Cost Optimization Settings
use_free_tier = true
deployment_type = "serverless"
enable_cost_optimization = true
use_single_az = false
enable_auto_scaling_cost_optimized = false
max_capacity_cost_optimized = 2

# Budget Configuration
monthly_budget = 50  # $50 monthly budget
alert_email = "your-email@domain.com"  # Replace with your email

# Tags
tags = {
  Owner       = "Your Name"
  CostCenter  = "IT Department"
  Environment = "production"
  Project     = "Nursery Management System"
  ManagedBy   = "Terraform"
  CostOptimized = "true"
}
```

## 🚀 Step 4: Domain Configuration

### 4.1 Register Domain (if needed)
```bash
# If you don't have a domain, register one at:
# - AWS Route53: https://console.aws.amazon.com/route53/
# - GoDaddy: https://www.godaddy.com/
# - Namecheap: https://www.namecheap.com/
```

### 4.2 Create Route53 Hosted Zone
```bash
# Create hosted zone for your domain
aws route53 create-hosted-zone \
  --name your-nursery-domain.com \
  --caller-reference $(date +%s)

# Note the nameservers from the output
# You'll need to update your domain registrar with these nameservers
```

### 4.3 Update Domain Nameservers
```bash
# Get the nameservers
aws route53 get-hosted-zone --id YOUR_HOSTED_ZONE_ID

# Update your domain registrar with these nameservers
# This process varies by registrar but typically involves:
# 1. Log into your domain registrar
# 2. Find DNS/Nameserver settings
# 3. Replace existing nameservers with AWS nameservers
# 4. Wait 24-48 hours for propagation
```

## 💰 Step 5: Cost Analysis & Planning

### 5.1 Run Cost Estimation
```bash
# Navigate back to project root
cd ../../..

# Make deployment script executable
chmod +x deployment/aws/deploy-cost-optimized.sh

# Check costs before deployment
./deployment/aws/deploy-cost-optimized.sh costs
```

### 5.2 Set Up Budget Alerts
```bash
# Create budget configuration file
cat > budget.json << EOF
{
  "BudgetName": "Nursery-Budget",
  "BudgetLimit": {
    "Amount": "50",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "NotificationsWithSubscribers": [
    {
      "Notification": {
        "ComparisonOperator": "GREATER_THAN",
        "NotificationType": "ACTUAL",
        "Threshold": 80,
        "ThresholdType": "PERCENTAGE"
      },
      "Subscribers": [
        {
          "Address": "your-email@domain.com",
          "SubscriptionType": "EMAIL"
        }
      ]
    }
  ]
}
EOF

# Create budget
aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget file://budget.json
```

## 🏗️ Step 6: Deploy Infrastructure

### 6.1 Deploy Cost-Optimized Infrastructure
```bash
# Deploy infrastructure only
./deployment/aws/deploy-cost-optimized.sh infrastructure

# This will:
# - Create VPC with 2 AZs (cost savings)
# - Deploy DocumentDB t3.micro
# - Deploy ElastiCache t3.micro
# - Create S3 buckets with lifecycle policies
# - Set up CloudFront distribution
# - Configure API Gateway
# - Create Lambda function
```

### 6.2 Monitor Infrastructure Creation
```bash
# Check deployment status
./deployment/aws/deploy-cost-optimized.sh status

# View Terraform outputs
cd deployment/aws/terraform
terraform output

# Expected outputs:
# - api_gateway_url
# - frontend_url
# - lambda_function_name
# - frontend_bucket
# - docdb_endpoint
# - redis_endpoint
```

## 🔧 Step 7: Deploy Application

### 7.1 Deploy Lambda Function
```bash
# Navigate back to project root
cd ../../..

# Deploy Lambda function
./deployment/aws/deploy-cost-optimized.sh lambda

# This will:
# - Create Lambda package
# - Install production dependencies
# - Upload to AWS Lambda
# - Configure environment variables
```

### 7.2 Deploy Frontend to S3
```bash
# Deploy frontend to S3
./deployment/aws/deploy-cost-optimized.sh frontend

# This will:
# - Build React application
# - Upload to S3 bucket
# - Invalidate CloudFront cache
# - Configure static website hosting
```

### 7.3 Run Complete Deployment
```bash
# Run complete deployment (if not done step by step)
./deployment/aws/deploy-cost-optimized.sh deploy

# This combines all steps:
# - Infrastructure deployment
# - Lambda deployment
# - Frontend deployment
# - Health checks
# - Cost optimization tests
```

## ✅ Step 8: Verification & Testing

### 8.1 Health Checks
```bash
# Get API Gateway URL
cd deployment/aws/terraform
API_URL=$(terraform output -raw api_gateway_url)
cd ../../..

# Test API health
curl -f "$API_URL/health"

# Expected response:
# {"status":"healthy","timestamp":"2024-01-01T00:00:00.000Z"}

# Test detailed health check
curl -f "$API_URL/health/detailed"
```

### 8.2 Frontend Testing
```bash
# Get frontend URL
cd deployment/aws/terraform
FRONTEND_URL=$(terraform output -raw frontend_url)
cd ../../..

# Test frontend access
curl -I "$FRONTEND_URL"

# Expected response:
# HTTP/2 200
# content-type: text/html
# ...
```

### 8.3 Cost Optimization Tests
```bash
# Run cost optimization tests
./deployment/aws/deploy-cost-optimized.sh test

# This will test:
# - API response time
# - Lambda cold start performance
# - S3 access
# - CloudFront caching
```

## 📊 Step 9: Cost Monitoring Setup

### 9.1 Enable Cost Explorer
```bash
# Enable Cost Explorer (if not already enabled)
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

### 9.2 Set Up CloudWatch Alarms
```bash
# Create CloudWatch alarm for Lambda errors
aws cloudwatch put-metric-alarm \
  --alarm-name nursery-lambda-errors \
  --alarm-description "Lambda function errors" \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --statistic Sum \
  --period 300 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --dimensions Name=FunctionName,Value=$(cd deployment/aws/terraform && terraform output -raw lambda_function_name)
```

### 9.3 Monitor Costs
```bash
# Get current month costs
aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

## 🔍 Step 10: Performance Optimization

### 10.1 Lambda Optimization
```bash
# Check Lambda function performance
aws lambda get-function \
  --function-name $(cd deployment/aws/terraform && terraform output -raw lambda_function_name)

# Monitor Lambda metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=$(cd deployment/aws/terraform && terraform output -raw lambda_function_name) \
  --start-time $(date -d '1 hour ago' --iso-8601=seconds) \
  --end-time $(date --iso-8601=seconds) \
  --period 300 \
  --statistics Average
```

### 10.2 CloudFront Optimization
```bash
# Get CloudFront distribution ID
DISTRIBUTION_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Aliases.Items[?contains(@, '$(cd deployment/aws/terraform && terraform output -raw frontend_bucket)')]].Id" --output text)

# Check CloudFront metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/CloudFront \
  --metric-name Requests \
  --dimensions Name=DistributionId,Value=$DISTRIBUTION_ID Name=Region,Value=Global \
  --start-time $(date -d '1 hour ago' --iso-8601=seconds) \
  --end-time $(date --iso-8601=seconds) \
  --period 300 \
  --statistics Sum
```

## 🛡️ Step 11: Security Verification

### 11.1 SSL Certificate Verification
```bash
# Test SSL configuration
curl -I https://your-nursery-domain.com

# Expected response:
# HTTP/2 200
# strict-transport-security: max-age=31536000; includeSubDomains
# ...
```

### 11.2 Security Headers Test
```bash
# Test security headers
curl -I https://your-nursery-domain.com/api/v1/user/login

# Should include:
# - X-Frame-Options
# - X-Content-Type-Options
# - X-XSS-Protection
# - Strict-Transport-Security
```

### 11.3 Rate Limiting Test
```bash
# Test rate limiting
for i in {1..10}; do
  curl -s -o /dev/null -w "%{http_code}\n" https://your-nursery-domain.com/api/v1/user/login
done
```

## 📈 Step 12: Cost Analysis & Optimization

### 12.1 Weekly Cost Review
```bash
# Create weekly cost report script
cat > weekly-cost-report.sh << 'EOF'
#!/bin/bash
echo "=== Weekly Cost Report ==="
echo "Date: $(date)"
echo ""

# Get weekly costs
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '7 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE

echo ""
echo "=== Cost Optimization Tips ==="
echo "1. Monitor Lambda cold starts"
echo "2. Check S3 lifecycle policies"
echo "3. Review CloudFront cache hit rates"
echo "4. Optimize database queries"
EOF

chmod +x weekly-cost-report.sh
```

### 12.2 Monthly Cost Analysis
```bash
# Create monthly cost analysis
aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE

# Compare with budget
aws budgets describe-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget-name Nursery-Budget
```

## 🔄 Step 13: Maintenance & Updates

### 13.1 Regular Maintenance Tasks
```bash
# Create maintenance script
cat > maintenance.sh << 'EOF'
#!/bin/bash
echo "=== Monthly Maintenance Tasks ==="

# 1. Update dependencies
echo "1. Updating dependencies..."
npm update

# 2. Check for security updates
echo "2. Checking for security updates..."
npm audit

# 3. Review and optimize Lambda functions
echo "3. Reviewing Lambda performance..."
aws lambda get-function --function-name $(cd deployment/aws/terraform && terraform output -raw lambda_function_name)

# 4. Check S3 lifecycle policies
echo "4. Checking S3 lifecycle policies..."
aws s3api get-bucket-lifecycle-configuration --bucket $(cd deployment/aws/terraform && terraform output -raw frontend_bucket)

# 5. Review CloudWatch logs
echo "5. Reviewing CloudWatch logs..."
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/nursery-backend
EOF

chmod +x maintenance.sh
```

### 13.2 Backup Verification
```bash
# Check DocumentDB backups
aws docdb describe-db-clusters \
  --db-cluster-identifier nursery-backend-docdb \
  --query 'DBClusters[0].BackupRetentionPeriod'

# Check S3 backup bucket
aws s3 ls s3://$(cd deployment/aws/terraform && terraform output -raw backup_bucket)
```

## 🎯 Step 14: Success Verification

### 14.1 Performance Metrics
```bash
# Verify performance targets
echo "=== Performance Verification ==="

# API response time
RESPONSE_TIME=$(curl -o /dev/null -s -w "%{time_total}" https://your-nursery-domain.com/health)
echo "API Response Time: ${RESPONSE_TIME}s (Target: < 0.2s)"

# Lambda cold start
COLD_START=$(curl -o /dev/null -s -w "%{time_total}" https://your-nursery-domain.com/health)
echo "Lambda Cold Start: ${COLD_START}s (Target: < 1s)"

# Availability check
AVAILABILITY=$(curl -f https://your-nursery-domain.com/health >/dev/null 2>&1 && echo "UP" || echo "DOWN")
echo "Service Availability: $AVAILABILITY (Target: UP)"
```

### 14.2 Cost Verification
```bash
# Verify cost targets
echo "=== Cost Verification ==="

MONTHLY_COST=$(aws ce get-cost-and-usage \
  --time-period Start=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --query 'ResultsByTime[0].Total.BlendedCost.Amount' \
  --output text)

echo "Monthly Cost: \$$MONTHLY_COST (Target: < \$50)"
echo "Cost Optimization: $(( (150 - ${MONTHLY_COST%.*}) * 100 / 150 ))% achieved"
```

## 🚨 Step 15: Troubleshooting

### 15.1 Common Issues & Solutions

#### Issue: Lambda Function Not Responding
```bash
# Check Lambda logs
aws logs tail /aws/lambda/nursery-backend-api --follow

# Check Lambda configuration
aws lambda get-function --function-name nursery-backend-api
```

#### Issue: High Costs
```bash
# Check cost breakdown
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '7 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE

# Check for unused resources
aws resourcegroupstaggingapi get-resources --resource-type-filters ec2:instance
```

#### Issue: SSL Certificate Problems
```bash
# Check certificate status
aws acm list-certificates --query 'CertificateSummaryList[?DomainName==`your-nursery-domain.com`]'

# Verify DNS records
aws route53 list-resource-record-sets --hosted-zone-id YOUR_HOSTED_ZONE_ID
```

### 15.2 Rollback Procedures
```bash
# Rollback deployment if needed
./deployment/aws/deploy-cost-optimized.sh rollback

# This will destroy all resources
# Use with caution!
```

## 📞 Step 16: Support & Resources

### 16.1 Useful Commands
```bash
# Check deployment status
./deployment/aws/deploy-cost-optimized.sh status

# View logs
aws logs tail /aws/lambda/nursery-backend-api --follow

# Monitor costs
aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-01-31 --granularity MONTHLY --metrics BlendedCost

# Check service health
curl -f https://your-nursery-domain.com/health
```

### 16.2 Documentation
- [AWS Cost Optimization Guide](deployment/aws/COST_OPTIMIZATION_GUIDE.md)
- [AWS Deployment Guide](deployment/aws/AWS_DEPLOYMENT_GUIDE.md)
- [Terraform Documentation](https://www.terraform.io/docs)
- [AWS Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)

## ✅ Deployment Checklist

- [ ] AWS account created and configured
- [ ] Free Tier eligibility verified
- [ ] Required tools installed
- [ ] Domain registered and configured
- [ ] Cost-optimized configuration set up
- [ ] Budget alerts configured
- [ ] Infrastructure deployed
- [ ] Lambda function deployed
- [ ] Frontend deployed to S3
- [ ] Health checks passed
- [ ] SSL certificate validated
- [ ] Cost monitoring active
- [ ] Performance tests passed
- [ ] Security tests passed
- [ ] Documentation updated

## 🎉 Success!

Your cost-optimized AWS deployment is now complete! You should have:

- ✅ **79% cost reduction** compared to traditional deployment
- ✅ **~$31/month** total cost (with Free Tier)
- ✅ **Serverless architecture** for optimal scaling
- ✅ **Comprehensive monitoring** and alerting
- ✅ **Security best practices** implemented
- ✅ **Performance optimization** applied

**Next Steps:**
1. Monitor costs weekly using the provided scripts
2. Review performance metrics monthly
3. Update dependencies quarterly
4. Optimize based on usage patterns

Your Nursery Management System is now running on AWS with maximum cost efficiency! 🚀💰 
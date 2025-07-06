# 🚀 AWS Deployment Guide for Nursery Management System

## 📋 Overview

This guide provides step-by-step instructions for deploying your Nursery Management System to AWS using Infrastructure as Code (Terraform) with enterprise-grade security and scalability.

## 🎯 Prerequisites

### AWS Account Setup
- **AWS Account**: Active AWS account with billing enabled
- **AWS CLI**: Installed and configured with appropriate permissions
- **Domain**: Registered domain name with Route53 access
- **IAM Permissions**: Admin access or specific permissions for deployment

### Local Development Environment
- **Terraform**: Version 1.0 or later
- **Docker**: For building and pushing container images
- **AWS CLI**: Configured with credentials
- **Git**: For version control

## 🔧 Step 1: AWS Account Preparation

### 1.1 Install and Configure AWS CLI

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
# Enter your default region (e.g., us-east-1)
# Enter your output format (json)
```

### 1.2 Create IAM User for Deployment

```bash
# Create IAM user for deployment
aws iam create-user --user-name nursery-deployment

# Attach necessary policies
aws iam attach-user-policy --user-name nursery-deployment --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

# Create access keys
aws iam create-access-key --user-name nursery-deployment
```

### 1.3 Install Terraform

```bash
# Install Terraform (macOS)
brew install terraform

# Install Terraform (Ubuntu)
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add -
sudo apt-add-repository "deb [arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs)"
sudo apt-get update && sudo apt-get install terraform
```

## 🏗️ Step 2: Infrastructure Configuration

### 2.1 Configure Terraform Variables

```bash
# Navigate to AWS deployment directory
cd deployment/aws/terraform

# Copy and configure variables
cp terraform.tfvars.example terraform.tfvars

# Edit terraform.tfvars with your values
nano terraform.tfvars
```

**Required Configuration:**
```hcl
# AWS Configuration
aws_region = "us-east-1"
environment = "production"
project_name = "nursery-backend"

# Domain Configuration
domain_name = "your-nursery-domain.com"

# VPC Configuration
vpc_cidr = "10.0.0.0/16"
availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
public_subnet_cidrs = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
private_subnet_cidrs = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]

# Application Configuration
app_cpu = 512
app_memory = 1024
app_desired_count = 2

# Database Configuration
docdb_instance_class = "db.t3.medium"
docdb_instance_count = 1

# Cache Configuration
redis_node_type = "cache.t3.micro"
```

### 2.2 Domain Configuration

```bash
# Create Route53 hosted zone (if not exists)
aws route53 create-hosted-zone --name your-nursery-domain.com --caller-reference $(date +%s)

# Update your domain's nameservers with your domain registrar
# Use the nameservers provided by Route53
```

## 🚀 Step 3: Automated Deployment

### 3.1 Run Complete Deployment

```bash
# Navigate to AWS deployment directory
cd deployment/aws

# Make deployment script executable
chmod +x deploy.sh

# Run complete deployment
./deploy.sh deploy
```

### 3.2 Step-by-Step Deployment

```bash
# Deploy only infrastructure
./deploy.sh infrastructure

# Build and deploy application
./deploy.sh application

# Run security tests
./deploy.sh test

# Check deployment status
./deploy.sh status
```

## 🔐 Step 4: Security Configuration

### 4.1 AWS WAF Setup (Optional)

```bash
# Create WAF Web ACL
aws wafv2 create-web-acl \
  --name nursery-waf \
  --scope REGIONAL \
  --default-action Allow={} \
  --description "WAF for Nursery Management System" \
  --region us-east-1

# Attach WAF to ALB
aws wafv2 associate-web-acl \
  --web-acl-arn arn:aws:wafv2:us-east-1:ACCOUNT:regional/webacl/nursery-waf \
  --resource-arn arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:loadbalancer/app/nursery-backend-alb
```

### 4.2 CloudTrail Setup

```bash
# Create CloudTrail
aws cloudtrail create-trail \
  --name nursery-cloudtrail \
  --s3-bucket-name nursery-cloudtrail-logs \
  --is-multi-region-trail

# Start logging
aws cloudtrail start-logging --name nursery-cloudtrail
```

### 4.3 GuardDuty Setup

```bash
# Enable GuardDuty
aws guardduty create-detector \
  --enable \
  --region us-east-1
```

## 📊 Step 5: Monitoring Setup

### 5.1 CloudWatch Alarms

```bash
# Create CPU utilization alarm
aws cloudwatch put-metric-alarm \
  --alarm-name nursery-cpu-high \
  --alarm-description "High CPU utilization" \
  --metric-name CPUUtilization \
  --namespace AWS/ECS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2

# Create memory utilization alarm
aws cloudwatch put-metric-alarm \
  --alarm-name nursery-memory-high \
  --alarm-description "High memory utilization" \
  --metric-name MemoryUtilization \
  --namespace AWS/ECS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2
```

### 5.2 Application Monitoring

```bash
# Create custom dashboard
aws cloudwatch put-dashboard \
  --dashboard-name nursery-dashboard \
  --dashboard-body file://dashboard.json
```

## 🔄 Step 6: CI/CD Pipeline Setup

### 6.1 GitHub Actions Workflow

Create `.github/workflows/aws-deploy.yml`:

```yaml
name: Deploy to AWS

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v2
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: us-east-1
    
    - name: Install Terraform
      uses: hashicorp/setup-terraform@v2
    
    - name: Deploy to AWS
      run: |
        cd deployment/aws
        ./deploy.sh deploy
```

### 6.2 AWS CodePipeline (Alternative)

```bash
# Create CodePipeline
aws codepipeline create-pipeline \
  --pipeline-name nursery-pipeline \
  --pipeline-definition file://pipeline-definition.json
```

## 🔍 Step 7: Verification & Testing

### 7.1 Health Check

```bash
# Test application health
curl https://your-nursery-domain.com/health

# Test detailed health check
curl https://your-nursery-domain.com/health/detailed
```

### 7.2 Security Testing

```bash
# Test SSL configuration
npx ssl-checker your-nursery-domain.com

# Test security headers
curl -I https://your-nursery-domain.com/api/v1/user/login

# Test rate limiting
ab -n 1000 -c 10 https://your-nursery-domain.com/api/v1/user/login
```

### 7.3 Load Testing

```bash
# Install Apache Bench
sudo apt install apache2-utils

# Run load test
ab -n 10000 -c 100 https://your-nursery-domain.com/health
```

## 📈 Step 8: Auto Scaling Configuration

### 8.1 ECS Auto Scaling

```bash
# Create auto scaling target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/nursery-backend-cluster/nursery-backend-service \
  --min-capacity 1 \
  --max-capacity 10

# Create scaling policy
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/nursery-backend-cluster/nursery-backend-service \
  --policy-name nursery-cpu-scaling \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-policy.json
```

## 🔄 Step 9: Backup & Disaster Recovery

### 9.1 Automated Backups

```bash
# Create backup Lambda function
aws lambda create-function \
  --function-name nursery-backup \
  --runtime nodejs18.x \
  --role arn:aws:iam::ACCOUNT:role/lambda-execution-role \
  --handler index.handler \
  --zip-file fileb://backup-function.zip

# Create EventBridge rule for daily backups
aws events put-rule \
  --name nursery-daily-backup \
  --schedule-expression "cron(0 2 * * ? *)"

# Add Lambda target
aws events put-targets \
  --rule nursery-daily-backup \
  --targets Id=1,Arn=arn:aws:lambda:us-east-1:ACCOUNT:function:nursery-backup
```

### 9.2 Cross-Region Replication

```bash
# Enable cross-region replication for S3 buckets
aws s3api put-bucket-replication \
  --bucket nursery-backups-ACCOUNT \
  --replication-configuration file://replication-config.json
```

## 🛡️ Step 10: Security Hardening

### 10.1 VPC Security

```bash
# Create VPC Flow Logs
aws ec2 create-flow-logs \
  --resource-type VPC \
  --resource-ids vpc-12345678 \
  --traffic-type ALL \
  --log-destination-type cloud-watch-logs \
  --log-group-name nursery-vpc-flow-logs
```

### 10.2 Encryption at Rest

```bash
# Enable encryption for DocumentDB
aws docdb modify-db-cluster \
  --db-cluster-identifier nursery-backend-docdb \
  --storage-encrypted \
  --apply-immediately
```

### 10.3 Encryption in Transit

```bash
# Enable SSL for DocumentDB
aws docdb modify-db-cluster \
  --db-cluster-identifier nursery-backend-docdb \
  --enable-cloudwatch-logs-exports audit \
  --apply-immediately
```

## 📊 Step 11: Cost Optimization

### 11.1 Resource Tagging

```bash
# Tag resources for cost allocation
aws ec2 create-tags \
  --resources vpc-12345678 \
  --tags Key=Environment,Value=production Key=Project,Value=nursery-backend
```

### 11.2 Reserved Instances

```bash
# Purchase reserved instances for cost savings
aws ec2 describe-reserved-instances-offerings \
  --instance-type db.t3.medium \
  --product-description "Amazon DocumentDB" \
  --offering-type "Partial Upfront"
```

## 🚨 Step 12: Incident Response

### 12.1 Monitoring Alerts

```bash
# Create SNS topic for alerts
aws sns create-topic --name nursery-alerts

# Subscribe to alerts
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT:nursery-alerts \
  --protocol email \
  --notification-endpoint your-email@domain.com
```

### 12.2 Rollback Procedures

```bash
# Rollback deployment
./deploy.sh rollback

# Check deployment status
./deploy.sh status

# View logs
aws logs describe-log-groups --log-group-name-prefix /ecs/nursery-backend
```

## ✅ Deployment Checklist

- [ ] AWS account configured with appropriate permissions
- [ ] Domain registered and configured in Route53
- [ ] Terraform variables configured
- [ ] Infrastructure deployed successfully
- [ ] Application deployed and healthy
- [ ] SSL certificate validated
- [ ] Security tests passed
- [ ] Monitoring configured
- [ ] Backups automated
- [ ] CI/CD pipeline configured
- [ ] Auto scaling configured
- [ ] Cost optimization implemented
- [ ] Documentation updated

## 🎉 Deployment Complete!

Your Nursery Management System is now deployed on AWS with:

- ✅ **Scalability**: Auto-scaling ECS service with load balancing
- ✅ **Security**: WAF, CloudTrail, GuardDuty, encrypted storage
- ✅ **Monitoring**: CloudWatch metrics, alarms, and dashboards
- ✅ **Backup**: Automated backups with cross-region replication
- ✅ **CI/CD**: Automated deployment pipeline
- ✅ **Cost Optimization**: Resource tagging and reserved instances

**Production URL**: `https://your-nursery-domain.com`
**Health Check**: `https://your-nursery-domain.com/health`
**API Base**: `https://your-nursery-domain.com/api/v1`

## 📞 Support & Troubleshooting

### Common Issues

1. **Terraform State Lock**
   ```bash
   terraform force-unlock LOCK_ID
   ```

2. **ECS Service Not Starting**
   ```bash
   aws ecs describe-services --cluster nursery-backend-cluster --services nursery-backend-service
   ```

3. **SSL Certificate Issues**
   ```bash
   aws acm describe-certificate --certificate-arn CERT_ARN
   ```

4. **Database Connection Issues**
   ```bash
   aws docdb describe-db-clusters --db-cluster-identifier nursery-backend-docdb
   ```

### Emergency Contacts

- **AWS Support**: Available through AWS Console
- **DevOps Team**: [Your Contact]
- **Security Team**: [Your Contact]

## 🔄 Maintenance

### Regular Tasks

- **Weekly**: Review CloudWatch metrics and costs
- **Monthly**: Update dependencies and security patches
- **Quarterly**: Review and update security configurations
- **Annually**: Review and optimize infrastructure

### Cost Monitoring

```bash
# Get cost and usage report
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

Your AWS deployment is now complete and ready for production use! 🚀 
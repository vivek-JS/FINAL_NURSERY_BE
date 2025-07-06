# 🚀 AWS Deployment for Nursery Management System

## 📋 Quick Start

```bash
# 1. Configure AWS credentials
aws configure

# 2. Set up deployment configuration
cd deployment/aws/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your domain and settings

# 3. Run automated deployment
cd ../..
chmod +x deployment/aws/deploy.sh
./deployment/aws/deploy.sh deploy
```

## 🏗️ Architecture Overview

This AWS deployment creates a production-ready infrastructure with:

### Core Infrastructure
- **VPC** with public/private subnets across 3 AZs
- **Application Load Balancer** with SSL termination
- **ECS Fargate** for containerized application
- **DocumentDB** (MongoDB compatible) for database
- **ElastiCache Redis** for caching and sessions

### Security & Monitoring
- **AWS WAF** for web application firewall
- **CloudTrail** for API audit logging
- **GuardDuty** for threat detection
- **CloudWatch** for monitoring and alerting
- **Secrets Manager** for secure credential storage

### Storage & Backup
- **S3** buckets for uploads, backups, and logs
- **Automated backups** with cross-region replication
- **VPC Flow Logs** for network monitoring

## 📁 File Structure

```
deployment/aws/
├── terraform/
│   ├── main.tf              # Main Terraform configuration
│   ├── variables.tf         # Variable definitions
│   ├── outputs.tf           # Output values
│   └── terraform.tfvars.example  # Example configuration
├── deploy.sh                # Automated deployment script
├── AWS_DEPLOYMENT_GUIDE.md  # Detailed deployment guide
└── README.md               # This file
```

## 🔧 Prerequisites

- AWS CLI configured with admin permissions
- Terraform 1.0+
- Docker installed
- Domain name registered
- Route53 hosted zone configured

## 🚀 Deployment Options

### Complete Deployment
```bash
./deployment/aws/deploy.sh deploy
```

### Step-by-Step Deployment
```bash
# Deploy infrastructure only
./deployment/aws/deploy.sh infrastructure

# Deploy application only
./deployment/aws/deploy.sh application

# Run security tests
./deployment/aws/deploy.sh test

# Check status
./deployment/aws/deploy.sh status
```

### Rollback
```bash
./deployment/aws/deploy.sh rollback
```

## 🔐 Security Features

- **Network Security**: Private subnets, security groups, VPC isolation
- **Application Security**: WAF, rate limiting, security headers
- **Data Security**: Encryption at rest and in transit
- **Access Control**: IAM roles, Secrets Manager
- **Monitoring**: CloudTrail, GuardDuty, VPC Flow Logs

## 📊 Monitoring & Alerting

- **Application Metrics**: CPU, memory, response times
- **Infrastructure Metrics**: ALB, ECS, database performance
- **Security Alerts**: WAF, GuardDuty, CloudTrail events
- **Cost Monitoring**: AWS Cost Explorer integration

## 💰 Cost Estimation

Estimated monthly costs (us-east-1):

| Service | Instance | Cost/Month |
|---------|----------|------------|
| ECS Fargate | 2 tasks (0.5 vCPU, 1GB) | ~$30 |
| DocumentDB | db.t3.medium | ~$70 |
| ElastiCache | cache.t3.micro | ~$15 |
| ALB | Standard | ~$20 |
| S3 | Storage + requests | ~$5 |
| CloudWatch | Logs + metrics | ~$10 |
| **Total** | | **~$150** |

*Costs may vary based on usage and region*

## 🔄 CI/CD Integration

### GitHub Actions
```yaml
name: Deploy to AWS
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: aws-actions/configure-aws-credentials@v2
      - run: ./deployment/aws/deploy.sh deploy
```

### AWS CodePipeline
- Automated builds and deployments
- Integration with CodeBuild and CodeDeploy
- Blue/green deployment support

## 🛠️ Maintenance

### Regular Tasks
- **Weekly**: Review metrics and costs
- **Monthly**: Update dependencies
- **Quarterly**: Security audits
- **Annually**: Infrastructure optimization

### Backup & Recovery
- Automated daily backups
- Cross-region replication
- Point-in-time recovery for DocumentDB
- Disaster recovery procedures

## 📞 Support

### Documentation
- [AWS Deployment Guide](AWS_DEPLOYMENT_GUIDE.md)
- [Terraform Documentation](https://www.terraform.io/docs)
- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)

### Troubleshooting
```bash
# Check ECS service status
aws ecs describe-services --cluster nursery-backend-cluster

# View application logs
aws logs tail /ecs/nursery-backend --follow

# Test health endpoint
curl https://your-domain.com/health
```

## 🎯 Next Steps

1. **Configure Domain**: Update `terraform.tfvars` with your domain
2. **Review Security**: Customize WAF rules and security groups
3. **Set Up Monitoring**: Configure CloudWatch alarms and dashboards
4. **Test Deployment**: Run security and load tests
5. **Configure CI/CD**: Set up automated deployment pipeline

## 📝 License

This deployment configuration is part of the Nursery Management System project.

---

**Ready to deploy?** Follow the [AWS Deployment Guide](AWS_DEPLOYMENT_GUIDE.md) for detailed instructions! 🚀 
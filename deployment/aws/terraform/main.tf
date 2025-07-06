# This file redirects to the cost-optimized configuration
# For cost-optimized deployment, use: cd cost-optimized && terraform init && terraform apply
# For full deployment, use the deploy.sh script instead

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# This is a placeholder configuration
# The actual cost-optimized configuration is in the cost-optimized/ directory
# Please use the deploy-cost-optimized.sh script for cost-optimized deployment 
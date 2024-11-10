class APIFeatures {
  constructor(query, queryString) {
    this.query = query;
    this.queryString = queryString;
  }

  filter() {
    const queryObj = { ...this.queryString };
    const excludedFields = ["page", "sort", "limit", "fields"];
    excludedFields.forEach((el) => delete queryObj[el]);

    if (this.queryString.startDate && this.queryString.endDate) {
      this.query = this.query
        .where("createdAt")
        .gte(this.queryString.startDate)
        .lte(this.queryString.endDate);
      delete queryObj["startDate"];
      delete queryObj["endDate"];
    }

    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);

    this.query = this.query.find(JSON.parse(queryStr));

    return this;
  }

  sort() {
    if (this.queryString.sort) {
      const sortBy = this.queryString.sort.split(",").join(" ");
      this.query = this.query.sort(sortBy);
    } else {
      this.query = this.query.sort("-createdAt");
    }

    return this;
  }

  limitFields() {
    if (this.queryString.fields) {
      const fields = this.queryString.fields.split(",").join(" ");
      this.query = this.query.select(fields);
    } else {
      this.query = this.query.select("-__v");
    }

    return this;
  }

  paginate() {
    const page = this.queryString.page * 1 || 1;
    const limit = this.queryString.limit * 1 || 10;
    const skip = (page - 1) * limit;

    this.query = this.query.skip(skip).limit(limit);

    return this;
  }
}

export default APIFeatures;


// class APIFeatures {
//   constructor(query, queryString, modelName) {
//     this.query = query;
//     this.queryString = queryString;
//     this.modelName = modelName;
//     this.isAggregation = false
//     this.pipeline = [];
//   }

//   filter() {
//     const queryObj = { ...this.queryString };
//     const excludedFields = ["page", "sort", "limit", "fields"];
//     excludedFields.forEach((el) => delete queryObj[el]);


//     if (this.modelName === "Order" && queryObj["farmer.mobileNumber"]) {
//       this.isAggregation = true;
//       const mobileNumber = queryObj["farmer.mobileNumber"];

//       // this.pipeline.push(
//       //   {
//       //     $lookup: {
//       //       from: "farmers", 
//       //       localField: "farmer",
//       //       foreignField: "_id",
//       //       as: "result",
//       //     },
//       //   },
//       //   {
//       //     $unwind: "$result",
//       //   },
//       //   {
//       //     $match: {
//       //       "result.mobileNumber": parseInt(mobileNumber),
//       //     },
//       //   },
//       //   {
//       //     $project: {
//       //       farmer: "result._id",
//       //       farmerName: "result.name",
//       //       farmerMobile: "result.mobileNumber",
//       //       salesPerson: 1,
//       //       typeOfPlants: 1,
//       //       numberOfPlants: 1,
//       //       modeOfPayment: 1,
//       //       rate: 1,
//       //       advance: 1,
//       //       dateOfAdvance: 1,
//       //       bankName: 1,
//       //       receiptPhoto: 1,
//       //       paymentStatus: 1,
//       //       payment: 1,
//       //       notes: 1,
//       //       createdAt: 1,
//       //       updatedAt: 1,
//       //     },
//       //   }
//       // );


//       delete queryObj["farmer.mobileNumber"];
//     } else {
//       // Process non-nested filters
//       let queryStr = JSON.stringify(queryObj);
//       queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);
//       this.query = this.query.find(JSON.parse(queryStr));
//     }

//     return this;
//   }

//   sort() {
//     if (this.isAggregation) {
//       // Apply sorting in aggregation
//       if (this.queryString.sort) {
//         const sortFields = this.queryString.sort.split(",").reduce((acc, field) => {
//           const [key, order] = field.startsWith("-") ? [field.slice(1), -1] : [field, 1];
//           acc[key] = order;
//           return acc;
//         }, {});
//         this.pipeline.push({ $sort: sortFields });
//       } else {
//         this.pipeline.push({ $sort: { createdAt: -1 } });
//       }
//     } else {
//       // Regular sort
//       if (this.queryString.sort) {
//         const sortBy = this.queryString.sort.split(",").join(" ");
//         this.query = this.query.sort(sortBy);
//       } else {
//         this.query = this.query.sort("-createdAt");
//       }
//     }
//     return this;
//   }

//   limitFields() {
//     if (this.isAggregation) {
//       // Apply field selection in aggregation
//       if (this.queryString.fields) {
//         const fields = this.queryString.fields.split(",").reduce((acc, field) => {
//           acc[field] = 1;
//           return acc;
//         }, {});
//         this.pipeline.push({ $project: fields });
//       } else {
//         this.pipeline.push({ $project: { __v: 0 } });
//       }
//     } else {
//       if (this.queryString.fields) {
//         const fields = this.queryString.fields.split(",").join(" ");
//         this.query = this.query.select(fields);
//       } else {
//         this.query = this.query.select("-__v");
//       }
//     }
//     return this;
//   }

//   paginate() {
//     const page = this.queryString.page * 1 || 1;
//     const limit = this.queryString.limit * 1 || 10;
//     const skip = (page - 1) * limit;

//     if (this.isAggregation) {
//       // Apply pagination in aggregation
//       this.pipeline.push({ $skip: skip }, { $limit: limit });
//     } else {
//       // Regular pagination
//       this.query = this.query.skip(skip).limit(limit);
//     }
//     return this;
//   }

//   async execute() {
//     if (this.isAggregation) {
//       // Use aggregation if pipeline stages are set
//       return await this.query.aggregate(this.pipeline).exec();
//     }
//     // Otherwise, use the regular query
//     return await this.query.lean();
//   }
// }

// export default APIFeatures;

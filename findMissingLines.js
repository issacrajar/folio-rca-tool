// Copyright (C) Agilysys, Inc. All rights reserved.

const XLSX = require("xlsx");
const fs = require("fs");

//read tenant list.xlsx to find the tenantId and propertyId using the PropertyCode as folioTransactions.[0].folioId till first _ from the excel to find TenantId and PropertyId

//JAXFW_Stay PMS_1000345 from this in folio Id 1000345 this is the chargePostingSequenceNumber
// to find accountId db.accounts.find({tenantId:tenantId,chargePostingSequenceNumber:chargePostingSequenceNumber})

// this is the query that used to get the excel
let mongoQuery = [
  {
    $match: {
      tenantId: "100321",
      propertyId: "273",
      "folioLines.accountId": "69db8f533c73562a489ca8ac"
    }
  },
  {
    $unwind: "$folioLines"
  },
  {
    $match: {
      "folioLines.accountId": "69db8f533c73562a489ca8ac"
    }
  },
  {
    $addFields: {
      "destinationAccountIdObj": {
        $convert: {
          input: "$destinationAccountId",
          to: "objectId",
          onError: null,
          onNull: null
        }
      }
    }
  },
  {
    $addFields: {
      "sourceAccountIdObj": {
        $convert: {
          input: "$sourceAccountId",
          to: "objectId",
          onError: null,
          onNull: null
        }
      }
    }
  },
  {
    $lookup: {
      from: "accounts",
      localField: "destinationAccountIdObj",
      foreignField: "_id",
      as: "destinationAccountDetails"
    }
  },
  {
    $lookup: {
      from: "accounts",
      localField: "sourceAccountIdObj",
      foreignField: "_id",
      as: "sourceAccountDetails"
    }
  },
  {
    $unwind: {
      path: "$destinationAccountDetails",
      preserveNullAndEmptyArrays: true
    }
  },  {
    $unwind: {
      path: "$sourceAccountDetails",
      preserveNullAndEmptyArrays: true
    }
  },

  {
    $project: {
      _id: 1,
      folioId: "$folioLines.folioId",
      accountId: "$folioLines.accountId",
      transactionId: "$folioLines._id",
      description: "$folioLines.description",
      itemId: "$folioLines.itemId",
      amount: "$folioLines.amount",
      adjustmentReferenceId: "$folioLines.adjustmentReferenceId",
      refundReferenceId: "$folioLines.refundReferenceId",
      sourceFolioLineItemId: "$folioLines.sourceFolioLineItemId",
      correctionReferenceId: "$folioLines.correctionReferenceId",
      transferReferenceId: "$folioLines.transferReferenceId",
      taxReferenceId: "$folioLines.taxReferenceId",
      quantity: "$folioLines.quantity",
      gatewayType: "$folioLines.gatewayType",
      type: "$type",
      originalType: "$folioLineType",

      // ✅ amount * quantity * 100
      totalAmount: {
        $toLong: {
          $multiply: [
            {
              $toDecimal: "$folioLines.amount"
            },
            {
              $toDecimal: "$folioLines.quantity"
            },
            100
          ]
        }
      },

      destinationAccountType: "$destinationAccountDetails.accountType",
      sourceAccountType: "$sourceAccountDetails.accountType"
    }
  }
];

// Give all the ledgerTransactions of this account.
const workbook = XLSX.readFile("folio_1000345.csv");
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];

const jsonData = XLSX.utils.sheet_to_json(sheet);


// make the graph query and give the resend result in this array.
let folioTransactions = [
  {
    "folioId":"JAXFW_Stay PMS_1000345_01_2026-04-04T10:17:10.904Z","folioType":{"folioTypeCode":"GS","folioTypeDesc":"Guest Stay"},"source":"Stay PMS","confirmationIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}],"bonvoyMemberFlag":false,"propertyCode":"JAXFW","creationTS":"2026-04-04T10:17:10.904Z","folioStatus":"Close","folioNumber":"1000345","folioWindowId":"01","invoiceFlag":false,"user":{"agentId":"jmunc077","lastName":"Muncie"},"resState":"Close","resCloseDate":"2026-05-08T00:00:00.000-04:00","windowProfileId":"JAXFW_GUST_69d0e5255a417b08bd7ab324","checkInAgent":{"agentId":"jmunc077","lastName":"Muncie"},"folioCloseDate":"2026-05-08T00:00:00.000-04:00","balance":{"currencyCode":"USD","value":0,"numberOfDecimals":2},"totalChargeAmt":{"currencyCode":"USD","value":0,"numberOfDecimals":2},"totalCreditAmt":{"currencyCode":"USD","value":0,"numberOfDecimals":2},"groupCode":"WBT","groupCreateTS":"2026-04-04T10:17:10.904Z","folioTransactionDetails":[{"folioId":"JAXFW_Stay PMS_1000345_01_2026-04-04T10:17:10.904Z","folioIdLineItemNo":"JAXFW_Stay PMS_1000345_01_2026-04-04T10:17:10.904Z_0394154606","lineItemNo":"0394154606","transType":"NEW","chargeCode":"PJ","transactionTS":"2026-04-25T00:00:00.000-04:00","businessTS":"2026-04-25T22:27:24.476-04:00","transDesc":"Market Beverage","transactionAmt":{"currencyCode":"USD","value":-600,"guestViewable":true,"numberOfDecimals":2},"summarizeFlag":false,"suppressionFlag":false,"transferFlag":false,"banquetChkFlag":false,"posFlag":false,"postedBy":{"agentId":"jmunc077","lastName":"Muncie"},"revenueType":{"revenueTypeCode":"BEVERAGENONALCOHOLIC","revenueTypeCodeDesc":"Beverage Non-alcoholic","revenueTypeCodeParent":"MARKETPANTRY"},"propertyCode":"JAXFW","folioType":{"folioTypeCode":"GS","folioTypeDesc":"Guest Stay"},"confirmationIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}],"resState":"Close","resCloseDate":"2026-05-08T00:00:00.000-04:00","taxInclusive":false,"groupCode":"WBT","groupCreateTS":"2026-04-04T10:17:10.904Z","roomNumber":"218","transPostingNotes":"Auto transfer to folio: 'ROUTED ALL-UPDATE'","folioTransferDetails":[{"transferTS":"2026-04-25T00:00:00.000-04:00","trnsfrFromfolioId":"JAXFW_Stay PMS_1000345_01_2026-04-04T10:17:10.904Z","trnsfrFromLineItemNo":"7370855545","trnsfrFromPropCode":"JAXFW","trnsfrFromConfIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}],"trnsfrByUser":{"agentId":"System","lastName":"System"},"trnsfrToFolioId":"JAXFW_Stay PMS_1000345_02_2026-04-04T10:17:10.904Z","trnsfrToLineItemNo":"3100814084","trnsfrToPropCode":"JAXFW","trnsfrToConfIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}]}]}]},
  {
    "folioId":"JAXFW_Stay PMS_1000345_02_2026-04-04T10:17:10.904Z","folioType":{"folioTypeCode":"GS","folioTypeDesc":"Guest Stay"},"source":"Stay PMS","confirmationIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}],"bonvoyMemberFlag":false,"propertyCode":"JAXFW","creationTS":"2026-04-04T10:17:10.904Z","folioStatus":"Close","folioNumber":"1000345","folioWindowId":"02","invoiceFlag":false,"user":{"agentId":"jmunc077","lastName":"Muncie"},"resState":"Close","resCloseDate":"2026-05-08T00:00:00.000-04:00","windowProfileId":"JAXFW_GUST_69d0e5255a417b08bd7ab324","checkInAgent":{"agentId":"jmunc077","lastName":"Muncie"},"folioCloseDate":"2026-05-08T00:00:00.000-04:00","balance":{"currencyCode":"USD","value":0,"numberOfDecimals":2},"totalChargeAmt":{"currencyCode":"USD","value":0,"numberOfDecimals":2},"totalCreditAmt":{"currencyCode":"USD","value":0,"numberOfDecimals":2},"groupCode":"WBT","groupCreateTS":"2026-04-04T10:17:10.904Z","folioTransactionDetails":[{"folioId":"JAXFW_Stay PMS_1000345_02_2026-04-04T10:17:10.904Z","folioIdLineItemNo":"JAXFW_Stay PMS_1000345_02_2026-04-04T10:17:10.904Z_3100814084","lineItemNo":"3100814084","transType":"NEW","chargeCode":"PJ","transactionTS":"2026-04-25T00:00:00.000-04:00","businessTS":"2026-04-25T22:27:24.476-04:00","transDesc":"Market Beverage","transactionAmt":{"currencyCode":"USD","value":600,"guestViewable":true,"numberOfDecimals":2},"summarizeFlag":false,"suppressionFlag":false,"transferFlag":false,"banquetChkFlag":false,"posFlag":false,"postedBy":{"agentId":"jmunc077","lastName":"Muncie"},"revenueType":{"revenueTypeCode":"BEVERAGENONALCOHOLIC","revenueTypeCodeDesc":"Beverage Non-alcoholic","revenueTypeCodeParent":"MARKETPANTRY"},"propertyCode":"JAXFW","folioType":{"folioTypeCode":"GS","folioTypeDesc":"Guest Stay"},"confirmationIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}],"resState":"Close","resCloseDate":"2026-05-08T00:00:00.000-04:00","taxInclusive":false,"groupCode":"WBT","groupCreateTS":"2026-04-04T10:17:10.904Z","roomNumber":"218","transPostingNotes":"Auto transfer from folio: 'Folio 1'","folioTransferDetails":[{"transferTS":"2026-04-25T00:00:00.000-04:00","trnsfrFromPropCode":"JAXFW","trnsfrFromConfIds":[{"id":"1","provider":"PMS","value":"5XTRZHXBB","type":"GS","description":"Guest Stay"},{"id":"2","provider":"ACRS","value":"9893980801","type":"GS","description":"Guest Stay"}]}]}]}
];



// Sum NEW and SET transactions separately for each folio
folioTransactions.forEach(folioTrans => {
  let newSum = 0;
  let setSum = 0;
  if(!folioTrans.folioTransactionDetails){
    folioTrans.folioTransactionDetails = [];
  }
  folioTrans.folioTransactionDetails.forEach(txn => {
    if (txn.transType === "NEW") {
      newSum += txn.transactionAmt.value;
    } else if (txn.transType === "SET") {
      setSum += txn.transactionAmt.value;
    }
  });
  console.log(`Folio: ${folioTrans.folioId} | Window: ${folioTrans.folioWindowId}`);
  console.log(`  NEW total: ${newSum} | SET total: ${setSum}`);
});

// // Flatten all the folios transactions into a single array for easier searching
// let transactions01=[...folioTransactions[0].folioTransactionDetails,...folioTransactions[1].folioTransactionDetails,...folioTran];
let transactions01=[];
folioTransactions.forEach(folioTrans=>{
  transactions01.push(...folioTrans.folioTransactionDetails);
});


let notFoundCount = 0;
let mismatchCount = 0;

jsonData.forEach(item => {
  let transaction = transactions01.find((transaction)=>item.lineItemNo===Number(transaction.lineItemNo));
  if(!transaction){
    notFoundCount++;
    console.log("No transaction found for lineItemNo: ", item.lineItemNo);
    return;

  }
  // const excelAmount = Math.round(Number(item.amount) * 100);
  if(item.type === "PAYMENT" || item.type === "REFUND" || ( item.sourceAccountType!=null && item.destinationAccountType === "COMPANY") || (item.type==="TRANSFER" && item.originalType==="PAYMENT")){
    if(transaction.transactionAmt.value !== -item.totalAmount || transaction.transType !== "SET"){
      mismatchCount++;
      console.log("Mismatch found for lineItemNo", item.lineItemNo);
    }
  }
  else
  {
    if(transaction.transactionAmt.value !== item.totalAmount || transaction.transType !== "NEW") {
      mismatchCount++;
      console.log(item.totalAmount, transaction.transactionAmt.value);
      console.log("Mismatch found for lineItemNo: ", item.lineItemNo);
    }
  }
});

console.log("Total transactions processed: ", transactions01.length);
console.log("Total transactions in JSON: ", jsonData.length);
console.log("Total transactions not found: ", notFoundCount);
console.log("Total mismatches found: ", mismatchCount);

if(mismatchCount == 0){
  console.log("There should be no OOB try updating account balance or need to analyse more.......")
}

transactions01.forEach(transaction => {
  let item = jsonData.find((data)=> data.lineItemNo===Number(transaction.lineItemNo));
  if(!item && transaction.transType!=="PKG"){
    console.log("Extra Lines sent other than ledgerTransactions", transaction.lineItemNo);
  }
  if(transaction.transType==="PKG"){
    let packageTransactions = transactions01.filter((data)=> data.transLinkId===transaction.lineItemNo);
    let amount = 0;
    packageTransactions.forEach(transaction => {
      amount+= transaction.transactionAmt.value ;
    })
    if(transaction.transactionAmt.value!==(amount/2))
    {
      console.log( "some transactions is missing transLinkId PKG line says" + transaction.transactionAmt.value + "transLinkId is sent only for "+ amount);
    }
  }
})

let folioLineIds=[];
folioTransactions.forEach(folioTrans => {
  folioTrans.folioTransactionDetails.forEach(folioTran => {
    if(folioTran.folioTransferDetails){
      let item = jsonData.find((data)=> data.lineItemNo===Number(folioTran.lineItemNo));
      folioLineIds.push(item?.adjustmentReferenceId);
      folioLineIds.push(item?.refundReferenceId);
      folioLineIds.push(item?.sourceFolioLineItemId);
      folioLineIds.push(item?.correctionReferenceId);
      folioLineIds.push(item?.transferReferenceId);
      folioLineIds.push(item?.taxReferenceId);
    }
  });
});


let transferMongoQuery = [
    {
      $match: {
          tenantId:"",
          propertyId:"",
        "folioLines._id": folioLineIds
      }
      },
  {
    $project:{
      _id: 1,
      folioId: "$folioLines.folioId",
      accountId: "$folioLines.accountId",
      transactionId: "$folioLines._id",
      description: "$folioLines.description",
      amount: "$folioLines.amount",
      itemId: "$folioLines.itemId",
      taxReferenceId: "$folioLines.taxReferenceId",
    }
  }
];

//do the mongo query in ledgerTransactions collection
let mongoData = [];

let folioLineIds=[];
folioTransactions.forEach(folioTrans => {
  folioTrans.folioTransactionDetails.forEach(folioTran => {
    if(folioTran.folioTransferDetails){
      let item = jsonData.find((data)=> data.lineItemNo===Number(folioTran.lineItemNo));
      if(item){
        // find the ledgerTransaction using any of this below id as folioLines._id(transactionId in the mongo data).
        // item?.adjustmentReferenceId;
        // item?.refundReferenceId;
        // item?.sourceFolioLineItemId;
        // item?.correctionReferenceId;
        // item?.transferReferenceId;


        //if its taxReferenceId find the ledgerTransaction using item.taxReference as folioLines._id(transactionId in the mongo data).
        // check if that has any of the folowing
        // item?.adjustmentReferenceId;
        // item?.refundReferenceId;
        // item?.sourceFolioLineItemId;
        // item?.correctionReferenceId;
        // item?.transferReferenceId;

        // if first condition satisfies we need to make the lineItemNo with that any of the id by taking first 10 numeric values of the id.
        //and verify that is the value present in folioTran.folioTransferDetails.trnsfrFromLineItemNo if yes then its correct orelse say its missing
        // if second condition is true that it has taxReferenceId then we need to find the mongoData that has folioLines._id same as taxReference and find if it has any of the fields
        // item?.adjustmentReferenceId;
        // item?.refundReferenceId;
        // item?.sourceFolioLineItemId;
        // item?.correctionReferenceId;
        // item?.transferReferenceId;
        // take that mongo data if its not present using this transferMongoQuery using the above fields in folioLines._id
        // group the folioLines that has the same as folioLines._id and taxReferenceId
        // now find the item.itemId in the group formed if it matches that objects transactionId should be the folioTran.folioTransferDetails.trnsfrFromLineItemNo after taking its first 10 numeric values.
      }
    }
  });
});

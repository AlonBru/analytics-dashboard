import path from 'path';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import { v4 } from 'uuid';
import {
  uniqBy,
  sortedUniqBy,
  map,
  sample,
  reject,
  includes,
  orderBy,
  flow,
  flatMap,
  curry,
  get,
  constant,
  filter,
  inRange,
  remove,
  countBy,
  groupBy,
} from 'lodash/fp';
import { isWithinInterval } from 'date-fns';
import low from 'lowdb';
import FileSync from 'lowdb/adapters/FileSync';
import shortid from 'shortid';
import Fuse from 'fuse.js';
import {
  BankAccount,
  Transaction,
  User,
  Contact,
  TransactionStatus,
  TransactionRequestStatus,
  Like,
  Comment,
  PaymentNotification,
  PaymentNotificationStatus,
  LikeNotification,
  CommentNotification,
  NotificationType,
  NotificationPayloadType,
  NotificationsType,
  TransactionResponseItem,
  TransactionPayload,
  BankTransfer,
  BankTransferPayload,
  BankTransferType,
  NotificationResponseItem,
  TransactionQueryPayload,
  DefaultPrivacyLevel,
  Event,
  weeklyRetentionObject,
  eventData,
  eventName,
  Location,
} from '../../client/src/models';
import {
  isPayment,
  getTransferAmount,
  hasSufficientFunds,
  getChargeAmount,
  hasDateQueryFields,
  getDateQueryFields,
  hasAmountQueryFields,
  getAmountQueryFields,
  getQueryWithoutFilterFields,
  getPayAppCreditedAmount,
  isRequestTransaction,
  formatFullName,
  isLikeNotification,
  isCommentNotification,
} from '../../client/src/utils/transactionUtils';
import { DbSchema } from '../../client/src/models/db-schema';
import { OneWeek, OneDay, OneHour } from './timeFrames';

export type TDatabase = {
  users: User[];
  contacts: Contact[];
  bankaccounts: BankAccount[];
  transactions: Transaction[];
  likes: Like[];
  comments: Comment[];
  notifications: NotificationType[];
  banktransfers: BankTransfer[];
  events: Event[];
};

const USER_TABLE = 'users';
const CONTACT_TABLE = 'contacts';
const BANK_ACCOUNT_TABLE = 'bankaccounts';
const TRANSACTION_TABLE = 'transactions';
const LIKE_TABLE = 'likes';
const COMMENT_TABLE = 'comments';
const NOTIFICATION_TABLE = 'notifications';
const BANK_TRANSFER_TABLE = 'banktransfers';
const EVENT_TABLE = 'events';

const databaseFile = path.join(__dirname, '../data/database.json');
const adapter = new FileSync<DbSchema>(databaseFile);

const db = low(adapter);

export const seedDatabase = () => {
  const testSeed = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'data', 'database.json'), 'utf-8'),
  );

  // seed database with test data
  db.setState(testSeed).write();
};

const backToMidnight = (time:number):number => new Date(new Date(time).toDateString()).getTime();
const nextDay = (time:number):number => new Date(new Date(time + OneDay + 2 * OneHour).toDateString()).getTime();

const dateString = (time:number):string => {
  const splitDate = new Date(time).toDateString().slice(4).split(' ');
  const [month, day, year] = splitDate;
  return [day, month, year].join('/');
};

export const getRetentionCohort = (dayZeroNumber:number):weeklyRetentionObject[] => {
  const dayZero:number = new Date(new Date(dayZeroNumber).toUTCString()).getTime();
  // const dayZero:number = backToMidnight(dayZeroNumber)
  const signups:Event[] = db
    .get('events')
    .filter(
      (event: Event) => event.name === 'signup' && event.date > dayZero,
    )
    .orderBy('date')
    .value();
  const logins : Event[] = db
    .get('events')
    .filter({ name: 'login' })
    .filter(({ date }) => date > dayZero)
    .orderBy('date')
    .value();

  const weekEnds:number[] = [];
  // stores the end time of every week since dayZero

  for (
    let d = new Date(new Date(dayZero - 2 * OneHour).toDateString()).getTime();
  // let d = backToMidnight(Date.now()) ;
    d < new Date(new Date().toDateString()).getTime() + OneWeek;
    d += OneWeek + 2 * OneHour
  ) {
    weekEnds.push(new Date(new Date(d).toDateString()).getTime() + OneWeek - 1);
  }

  const weeklyRetention:weeklyRetentionObject[] = weekEnds.map((weekEnd, weekNumber) => {
    // first isolate the new Users the week

    const weeksNewSignups = signups.filter((signup:Event) => signup.date <= weekEnd);
    signups.splice(0, weeksNewSignups.length);

    // second isolate the logins of users who started this week
    const loginsByNewUsers = logins
      .filter(({ distinct_user_id: loginId }) => weeksNewSignups.some(({ distinct_user_id: signupId }) => loginId === signupId));

    const weeklyRetention:number[] = [];

    // third for every following week we must find how many of the new Users came back
    for (let i = weekNumber; i < weekEnds.length; i++) {
      const returnedUsers : {id:string, date:string}[] = [];

      const weeksLogins = loginsByNewUsers.filter((login:Event) => login.date <= weekEnds[i]);
      loginsByNewUsers.splice(0, weeksLogins.length);

      weeksLogins.forEach(({ distinct_user_id, date }) => {
        if (!returnedUsers.some((user) => user.id === distinct_user_id)) {
          returnedUsers.push({ id: distinct_user_id, date: new Date(date).toDateString() });
        }
      });
      if (weekNumber === 0 && i === 1 || weekNumber === 4 && i === 5) {
      // console.log('week'+weekNumber,returnedUsers)
      }
      weeklyRetention.push(returnedUsers.length);
    }

    const newUsers = weeksNewSignups.length;
    const weeklyRetentionPercent = [100].concat(
      newUsers
        ? weeklyRetention.slice(1).map((returnedUsers) => Math.round(100 * returnedUsers / newUsers))
        : weeklyRetention.slice(1),
    );
    return {
      registrationWeek: weekNumber,
      start: new Date(dayZero + weekNumber * OneWeek).toDateString().slice(4),
      end: (new Date(weekEnds[weekNumber] - 1)).toDateString().slice(4),
      newUsers,
      weeklyRetention: weeklyRetentionPercent,
    };
  });

  return weeklyRetention;
};

export const getAllEvents = (
  {
    sorting,
    type,
    browser,
    search,
    offset,
    page,
  }:{
    sorting?:string;
    type?: eventName;
    browser?: string;
    search?: string;
    offset?: number;
    page?: number;
  },
) :Event[]|{events:Event[], more:boolean} => {
  if (!sorting) {
    sorting = '-date';
  }
  const sort = sorting.slice(1);
  const direction = sorting.slice(0, 1);
  const events = db.get('events')
    .filter((event) => {
      const fitsType = type ? event.name === type : true;
      const fitsBrowser = browser ? event.browser === browser : true;
      let fitsSearch:boolean = !search;
      if (search) {
        const regex = new RegExp(search);
        fitsSearch = Object.keys(event).some((key) => (key === 'date' ? false : regex.test(event[key].toString())));
      }
      return (fitsBrowser && fitsSearch && fitsType);
    })
    .orderBy(sort, direction === '-' ? 'desc' : 'asc')
    .slice(page || 0, page ? page + 10 : undefined)
    .value();
  return offset
    ? {
      events: events.slice(0, offset),
      more: events.slice(0, offset).length !== events.length,
    }
    : events;
};

export const createEvent = (eventData:any) => {
  db.get(EVENT_TABLE).push(eventData).write();
};

export const getSessionsByDay = (offset = 0) : {date:string, count:number}[] => {
  const days: number[] = new Array(offset || 7).fill(1)
    .map((day, i) => (backToMidnight(Date.now() - i * OneDay - offset * OneDay)));
  const events = db.get(EVENT_TABLE)
    .orderBy('date', 'asc');

  const sessionsByDays = days.map((day) => ({
    date: dateString(day),
    count: events
      .filter(((event) => event.date > day))
      .filter(((event) => event.date < nextDay(day)))
      .uniqBy('session_id')
      .value().length,
  }));

  return sessionsByDays.reverse();
};

export const getSessionsByHour = (offset = 0) : {hour:string, count:number}[] => {
  const midnight : number = backToMidnight(Date.now() - offset * OneDay);
  const tomorrow :number = backToMidnight(midnight + 25 * OneHour);

  const sessionsToday : Event[] = db
    .get('events')
    .filter((event) => event.date >= midnight && event.date < tomorrow)
    .uniqBy('session_id')
    .value();
  const sessionsByHour : {hour:string, count:number}[] = [];

  for (let hour = tomorrow - OneHour; hour >= midnight; hour -= OneHour) {
    const hourString : number = new Date(hour).getHours();
    const firstSession :number = sessionsToday.findIndex(({ date }) => date > hour);
    const count : number = sessionsToday.splice(firstSession).length;
    sessionsByHour.push({
      hour: `${hourString}:00`,
      count,
    });
  }
  return sessionsByHour;
};

export const countEventsBy = (what:string) : {name:string, count:number}[] => {
  const events = db.get('events').countBy(what).value();
  return Object.keys(events).map((name) => ({
    name, count: events[name],
  })).sort((curr, next) => next.count - curr.count);
};

export const getFilterValues = () => {
  const type = db.get('events').uniqBy('name').map(({ name }) => name).value();
  const browser = db.get('events').uniqBy('browser').map(({ browser }) => browser).value();
  return { type, browser };
};

type MapData = {
  location:Location,
  date:string,
  user:string,
  avatar:string
}
export const getEventsGeoData = () : MapData[] => {
  const events:Event[] = db.get('events').value();
  const users:User[] = db.get('users').value();

  return events.map(({
    geolocation, date, distinct_user_id, name,
  }) => {
    const user = users.find((user) => user.id === distinct_user_id);
    return {
      location: geolocation.location,
      type: name,
      date: dateString(date),
      user: user!.username,
      avatar: user!.avatar,
    };
  });
};

export const getAllUsers = () => db.get(USER_TABLE).value();

export const getAllPublicTransactions = () => db.get(TRANSACTION_TABLE).filter({ privacyLevel: DefaultPrivacyLevel.public }).value();

export const getAllForEntity = (entity: keyof DbSchema) => db.get(entity).value();

export const getAllBy = (entity: keyof DbSchema, key: string, value: any) => {
  const result = db
    .get(entity)
    // @ts-ignore
    .filter({ [`${key}`]: value })
    .value();

  return result;
};

export const getBy = (entity: keyof DbSchema, key: string, value: any) => {
  const result = db
    .get(entity)
    // @ts-ignore
    .find({ [`${key}`]: value })
    .value();

  return result;
};

export const getAllByObj = (entity: keyof DbSchema, query: object) => {
  const result = db
    .get(entity)
    // @ts-ignore
    .filter(query)
    .value();

  return result;
};

// Search
export const cleanSearchQuery = (query: string) => query.replace(/[^a-zA-Z0-9]/g, '');

export const setupSearch = curry((items: object[], options: {}, query: string) => {
  const fuse = new Fuse(items, options);
  return fuse.search(query);
});

export const performSearch = (items: object[], options: {}, query: string) => flow(
  cleanSearchQuery,
  setupSearch(items, options),
  map((result) => result.item),
)(query);

export const searchUsers = (query: string) => {
  const items = getAllUsers();
  return performSearch(
    items,
    {
      keys: ['firstName', 'lastName', 'username', 'email', 'phoneNumber'],
    },
    query,
  ) as User[];
};

export const removeUserFromResults = (userId: User['id'], results: User[]) => remove({ id: userId }, results);

// convenience methods

// User
export const getUserBy = (key: string, value: any) => getBy(USER_TABLE, key, value);
export const getUserId = (user: User): string => user.id;
export const getUserById = (id: string) => getUserBy('id', id);
export const getUserByUsername = (username: string) => getUserBy('username', username);

export const createUser = (userDetails: Partial<User>): User => {
  const password = bcrypt.hashSync(userDetails.password!, 10);
  const user: User = {
    id: shortid(),
    uuid: v4(),
    firstName: userDetails.firstName!,
    lastName: userDetails.lastName!,
    username: userDetails.username!,
    password,
    email: userDetails.email!,
    phoneNumber: userDetails.phoneNumber!,
    balance: userDetails.balance! || 0,
    avatar: userDetails.avatar!,
    defaultPrivacyLevel: userDetails.defaultPrivacyLevel!,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  saveUser(user);
  return user;
};

const saveUser = (user: User) => {
  db.get(USER_TABLE).push(user).write();
};

export const updateUserById = (userId: string, edits: Partial<User>) => {
  const user = getUserById(userId);

  db.get(USER_TABLE).find(user).assign(edits).write();
};

// Contact
export const getContactBy = (key: string, value: any) => getBy(CONTACT_TABLE, key, value);

export const getContactsBy = (key: string, value: any) => getAllBy(CONTACT_TABLE, key, value);

export const getContactsByUsername = (username: string) => flow(getUserByUsername, getUserId, getContactsByUserId)(username);

export const getContactsByUserId = (userId: string): Contact[] => getContactsBy('userId', userId);

export const createContact = (contact: Contact) => {
  db.get(CONTACT_TABLE).push(contact).write();

  // manual lookup after create
  return getContactBy('id', contact.id);
};

export const removeContactById = (contactId: string) => {
  const contact = getContactBy('id', contactId);

  db.get(CONTACT_TABLE).remove(contact).write();
};

export const createContactForUser = (userId: string, contactUserId: string) => {
  const contactId = shortid();
  const contact: Contact = {
    id: contactId,
    uuid: v4(),
    userId,
    contactUserId,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  // Write contact record to the database
  const result = createContact(contact);

  return result;
};

// Bank Account
export const getBankAccountBy = (key: string, value: any) => getBy(BANK_ACCOUNT_TABLE, key, value);

export const getBankAccountById = (id: string) => getBankAccountBy('id', id);

export const getBankAccountsBy = (key: string, value: any) => getAllBy(BANK_ACCOUNT_TABLE, key, value);

export const createBankAccount = (bankaccount: BankAccount) => {
  db.get(BANK_ACCOUNT_TABLE).push(bankaccount).write();

  // manual lookup after create
  return getBankAccountBy('id', bankaccount.id);
};

export const createBankAccountForUser = (userId: string, accountDetails: Partial<BankAccount>) => {
  const accountId = shortid();
  const bankaccount: BankAccount = {
    id: accountId,
    uuid: v4(),
    userId,
    bankName: accountDetails.bankName!,
    accountNumber: accountDetails.accountNumber!,
    routingNumber: accountDetails.routingNumber!,
    isDeleted: false,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  // Write bank account record to the database
  const result = createBankAccount(bankaccount);

  return result;
};

export const removeBankAccountById = (bankAccountId: string) => {
  db.get(BANK_ACCOUNT_TABLE)
    .find({ id: bankAccountId })
    .assign({ isDeleted: true }) // soft delete
    .write();
};

// Bank Transfer
// Note: Balance transfers from/to bank accounts is a future feature,
// but some of the backend database functionality is already implemented here.

/* istanbul ignore next */
export const getBankTransferBy = (key: string, value: any) => getBy(BANK_TRANSFER_TABLE, key, value);

export const getBankTransfersBy = (key: string, value: any) => getAllBy(BANK_TRANSFER_TABLE, key, value);

export const getBankTransfersByUserId = (userId: string) => getBankTransfersBy('userId', userId);

/* istanbul ignore next */
export const createBankTransfer = (bankTransferDetails: BankTransferPayload) => {
  const bankTransfer: BankTransfer = {
    id: shortid(),
    uuid: v4(),
    ...bankTransferDetails,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  const savedBankTransfer = saveBankTransfer(bankTransfer);
  return savedBankTransfer;
};

/* istanbul ignore next */
const saveBankTransfer = (bankTransfer: BankTransfer): BankTransfer => {
  db.get(BANK_TRANSFER_TABLE).push(bankTransfer).write();

  // manual lookup after banktransfer created
  return getBankTransferBy('id', bankTransfer.id);
};

// Transaction

export const getTransactionBy = (key: string, value: any) => getBy(TRANSACTION_TABLE, key, value);

export const getTransactionById = (id: string) => getTransactionBy('id', id);

export const getTransactionsByObj = (query: object) => getAllByObj(TRANSACTION_TABLE, query);

export const getTransactionByIdForApi = (id: string) => formatTransactionForApiResponse(getTransactionBy('id', id));

export const getTransactionsForUserForApi = (userId: string, query?: object) => flow(getTransactionsForUserByObj(userId), formatTransactionsForApiResponse)(query);

export const getFullNameForUser = (userId: User['id']) => flow(getUserById, formatFullName)(userId);

export const formatTransactionForApiResponse = (
  transaction: Transaction,
): TransactionResponseItem => {
  const receiver = getUserById(transaction.receiverId);
  const sender = getUserById(transaction.senderId);

  const receiverName = getFullNameForUser(transaction.receiverId);
  const senderName = getFullNameForUser(transaction.senderId);
  const likes = getLikesByTransactionId(transaction.id);
  const comments = getCommentsByTransactionId(transaction.id);

  return {
    receiverName,
    senderName,
    receiverAvatar: receiver.avatar,
    senderAvatar: sender.avatar,
    likes,
    comments,
    ...transaction,
  };
};

export const formatTransactionsForApiResponse = (
  transactions: Transaction[],
): TransactionResponseItem[] => orderBy(
  [(transaction: Transaction) => new Date(transaction.modifiedAt)],
  ['desc'],
  transactions.map((transaction) => formatTransactionForApiResponse(transaction)),
);

export const getAllTransactionsForUserByObj = curry((userId: string, query?: object) => {
  const queryWithoutFilterFields = query && getQueryWithoutFilterFields(query);

  const queryFields = queryWithoutFilterFields || query;

  const userTransactions = flatMap(getTransactionsByObj)([
    {
      receiverId: userId,
      ...queryFields,
    },
    {
      senderId: userId,
      ...queryFields,
    },
  ]);

  if (query && (hasDateQueryFields(query) || hasAmountQueryFields(query))) {
    const { dateRangeStart, dateRangeEnd } = getDateQueryFields(query);
    const { amountMin, amountMax } = getAmountQueryFields(query);

    return flow(
      transactionsWithinDateRange(dateRangeStart!, dateRangeEnd!),
      transactionsWithinAmountRange(amountMin!, amountMax!),
    )(userTransactions);
  }
  return userTransactions;
});

export const transactionsWithinAmountRange = curry(
  (amountMin: number, amountMax: number, transactions: Transaction[]) => {
    if (!amountMin || !amountMax) {
      return transactions;
    }

    return filter(
      (transaction: Transaction) => inRange(amountMin, amountMax, transaction.amount),
      transactions,
    );
  },
);

export const transactionsWithinDateRange = curry(
  (dateRangeStart: string, dateRangeEnd: string, transactions: Transaction[]) => {
    if (!dateRangeStart || !dateRangeEnd) {
      return transactions;
    }

    return filter(
      (transaction: Transaction) => isWithinInterval(new Date(transaction.createdAt), {
        start: new Date(dateRangeStart),
        end: new Date(dateRangeEnd),
      }),
      transactions,
    );
  },
);

export const getTransactionsForUserByObj = curry((userId: string, query?: object) => flow(getAllTransactionsForUserByObj(userId), uniqBy('id'))(query));

export const getContactIdsForUser = (userId: string): Contact['id'][] => flow(getContactsByUserId, map('contactUserId'))(userId);

export const getTransactionsForUserContacts = (userId: string, query?: object) => uniqBy(
  'id',
  flatMap(
    (contactId) => getTransactionsForUserForApi(contactId, query),
    getContactIdsForUser(userId),
  ),
);

export const getTransactionIds = (transactions: Transaction[]) => map('id', transactions);

export const getContactsTransactionIds = (userId: string): Transaction['id'][] => flow(getTransactionsForUserContacts, getTransactionIds)(userId);

export const nonContactPublicTransactions = (userId: string): Transaction[] => {
  const contactsTransactionIds = getContactsTransactionIds(userId);
  return flow(
    getAllPublicTransactions,
    reject((transaction: Transaction) => includes(transaction.id, contactsTransactionIds)),
  )();
};

export const getNonContactPublicTransactionsForApi = (userId: string) => flow(nonContactPublicTransactions, formatTransactionsForApiResponse)(userId);

export const getPublicTransactionsDefaultSort = (userId: string) => ({
  contactsTransactions: getTransactionsForUserContacts(userId),
  publicTransactions: getNonContactPublicTransactionsForApi(userId),
});

export const getPublicTransactionsByQuery = (userId: string, query: TransactionQueryPayload) => {
  if (query && (hasDateQueryFields(query) || hasAmountQueryFields(query))) {
    const { dateRangeStart, dateRangeEnd } = getDateQueryFields(query);
    const { amountMin, amountMax } = getAmountQueryFields(query);

    return {
      contactsTransactions: getTransactionsForUserContacts(userId, query),
      publicTransactions: flow(
        transactionsWithinDateRange(dateRangeStart!, dateRangeEnd!),
        transactionsWithinAmountRange(amountMin!, amountMax!),
      )(getNonContactPublicTransactionsForApi(userId)),
    };
  }
  return {
    contactsTransactions: getTransactionsForUserContacts(userId),
    publicTransactions: getNonContactPublicTransactionsForApi(userId),
  };
};

export const resetPayAppBalance = constant(0);

export const debitPayAppBalance = (user: User, transaction: Transaction) => {
  if (hasSufficientFunds(user, transaction)) {
    flow(getChargeAmount, savePayAppBalance(user))(user, transaction);
  } else {
    /* istanbul ignore next */
    flow(
      getTransferAmount(user),
      createBankTransferWithdrawal(user, transaction),
      resetPayAppBalance,
      savePayAppBalance(user),
    )(transaction);
  }
};

export const creditPayAppBalance = (user: User, transaction: Transaction) => flow(getPayAppCreditedAmount, savePayAppBalance(user))(user, transaction);

/* istanbul ignore next */
export const createBankTransferWithdrawal = curry(
  (sender: User, transaction: Transaction, transferAmount: number) => createBankTransfer({
    userId: sender.id,
    source: transaction.source,
    amount: transferAmount,
    transactionId: transaction.id,
    type: BankTransferType.withdrawal,
  }),
);

export const savePayAppBalance = curry((sender: User, balance: number) => updateUserById(get('id', sender), { balance }));

export const createTransaction = (
  userId: User['id'],
  transactionType: 'payment' | 'request',
  transactionDetails: TransactionPayload,
): Transaction => {
  const sender = getUserById(userId);
  const receiver = getUserById(transactionDetails.receiverId);
  const transaction: Transaction = {
    id: shortid(),
    uuid: v4(),
    source: transactionDetails.source,
    amount: transactionDetails.amount * 100,
    description: transactionDetails.description,
    receiverId: transactionDetails.receiverId,
    senderId: userId,
    privacyLevel: transactionDetails.privacyLevel || sender.defaultPrivacyLevel,
    status: TransactionStatus.pending,
    requestStatus: transactionType === 'request' ? TransactionRequestStatus.pending : undefined,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  const savedTransaction = saveTransaction(transaction);

  // if payment, debit sender's balance for payment amount
  if (isPayment(transaction)) {
    debitPayAppBalance(sender, transaction);
    creditPayAppBalance(receiver, transaction);
    updateTransactionById(transaction.id, {
      status: TransactionStatus.complete,
    });
    createPaymentNotification(
      transaction.receiverId,
      transaction.id,
      PaymentNotificationStatus.received,
    );
  } else {
    createPaymentNotification(
      transaction.receiverId,
      transaction.id,
      PaymentNotificationStatus.requested,
    );
  }

  return savedTransaction;
};

const saveTransaction = (transaction: Transaction): Transaction => {
  db.get(TRANSACTION_TABLE).push(transaction).write();

  // manual lookup after transaction created
  return getTransactionBy('id', transaction.id);
};

export const updateTransactionById = (transactionId: string, edits: Partial<Transaction>) => {
  const transaction = getTransactionBy('id', transactionId);
  const { senderId, receiverId } = transaction;
  const sender = getUserById(senderId);
  const receiver = getUserById(receiverId);

  // if payment, debit sender's balance for payment amount
  if (isRequestTransaction(transaction)) {
    debitPayAppBalance(receiver, transaction);
    creditPayAppBalance(sender, transaction);
    edits.status = TransactionStatus.complete;

    createPaymentNotification(
      transaction.senderId,
      transaction.id,
      PaymentNotificationStatus.received,
    );
  }

  db.get(TRANSACTION_TABLE).find(transaction).assign(edits).write();
};

// Likes

export const getLikeBy = (key: string, value: any): Like => getBy(LIKE_TABLE, key, value);
export const getLikesByObj = (query: object) => getAllByObj(LIKE_TABLE, query);

export const getLikeById = (id: string): Like => getLikeBy('id', id);
export const getLikesByTransactionId = (transactionId: string) => getLikesByObj({ transactionId });

export const createLike = (userId: string, transactionId: string): Like => {
  const like = {
    id: shortid(),
    uuid: v4(),
    userId,
    transactionId,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  const savedLike = saveLike(like);
  return savedLike;
};

export const createLikes = (userId: string, transactionId: string) => {
  const { senderId, receiverId } = getTransactionById(transactionId);

  const like = createLike(userId, transactionId);

  /* istanbul ignore next */
  if (userId !== senderId || userId !== receiverId) {
    createLikeNotification(senderId, transactionId, like.id);
    createLikeNotification(receiverId, transactionId, like.id);
  } else if (userId === senderId) {
    createLikeNotification(senderId, transactionId, like.id);
  } else {
    createLikeNotification(receiverId, transactionId, like.id);
  }
};

const saveLike = (like: Like): Like => {
  db.get(LIKE_TABLE).push(like).write();

  // manual lookup after like created
  return getLikeById(like.id);
};

// Comments

export const getCommentBy = (key: string, value: any): Comment => getBy(COMMENT_TABLE, key, value);
export const getCommentsByObj = (query: object) => getAllByObj(COMMENT_TABLE, query);

export const getCommentById = (id: string): Comment => getCommentBy('id', id);
export const getCommentsByTransactionId = (transactionId: string) => getCommentsByObj({ transactionId });

export const createComment = (userId: string, transactionId: string, content: string): Comment => {
  const comment = {
    id: shortid(),
    uuid: v4(),
    content,
    userId,
    transactionId,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  const savedComment = saveComment(comment);
  return savedComment;
};

export const createComments = (userId: string, transactionId: string, content: string) => {
  const { senderId, receiverId } = getTransactionById(transactionId);

  const comment = createComment(userId, transactionId, content);

  /* istanbul ignore next */
  if (userId !== senderId || userId !== receiverId) {
    createCommentNotification(senderId, transactionId, comment.id);
    createCommentNotification(receiverId, transactionId, comment.id);
  } else if (userId === senderId) {
    createCommentNotification(senderId, transactionId, comment.id);
  } else {
    createCommentNotification(receiverId, transactionId, comment.id);
  }
};

const saveComment = (comment: Comment): Comment => {
  db.get(COMMENT_TABLE).push(comment).write();

  // manual lookup after comment created
  return getCommentById(comment.id);
};

// Notifications

export const getNotificationBy = (key: string, value: any): NotificationType => getBy(NOTIFICATION_TABLE, key, value);

export const getNotificationsByObj = (query: object): Notification[] => getAllByObj(NOTIFICATION_TABLE, query);

export const getUnreadNotificationsByUserId = (userId: string) => flow(getNotificationsByObj, formatNotificationsForApiResponse)({ userId, isRead: false });

export const createPaymentNotification = (
  userId: string,
  transactionId: string,
  status: PaymentNotificationStatus,
): PaymentNotification => {
  const notification: PaymentNotification = {
    id: shortid(),
    uuid: v4(),
    userId,
    transactionId,
    status,
    isRead: false,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  saveNotification(notification);
  return notification;
};

export const createLikeNotification = (
  userId: string,
  transactionId: string,
  likeId: string,
): LikeNotification => {
  const notification: LikeNotification = {
    id: shortid(),
    uuid: v4(),
    userId,
    transactionId,
    likeId,
    isRead: false,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  saveNotification(notification);
  return notification;
};

export const createCommentNotification = (
  userId: string,
  transactionId: string,
  commentId: string,
): CommentNotification => {
  const notification: CommentNotification = {
    id: shortid(),
    uuid: v4(),
    userId,
    transactionId,
    commentId,
    isRead: false,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };

  saveNotification(notification);
  return notification;
};

const saveNotification = (notification: NotificationType) => {
  db.get(NOTIFICATION_TABLE).push(notification).write();
};

export const createNotifications = (userId: string, notifications: NotificationPayloadType[]) => notifications.flatMap((item: NotificationPayloadType) => {
  if ('status' in item && item.type === NotificationsType.payment) {
    return createPaymentNotification(userId, item.transactionId, item.status);
  } if ('likeId' in item && item.type === NotificationsType.like) {
    return createLikeNotification(userId, item.transactionId, item.likeId);
  }
  /* istanbul ignore next */
  if ('commentId' in item) {
    return createCommentNotification(userId, item.transactionId, item.commentId);
  }
});

export const updateNotificationById = (
  userId: string,
  notificationId: string,
  edits: Partial<NotificationType>,
) => {
  const notification = getNotificationBy('id', notificationId);

  db.get(NOTIFICATION_TABLE).find(notification).assign(edits).write();
};

export const formatNotificationForApiResponse = (
  notification: NotificationType,
): NotificationResponseItem => {
  let userFullName = getFullNameForUser(notification.userId);
  const transaction = getTransactionById(notification.transactionId);

  if (isRequestTransaction(transaction)) {
    userFullName = getFullNameForUser(transaction.senderId);
  }

  if (isLikeNotification(notification)) {
    const like = getLikeById(notification.likeId);
    userFullName = getFullNameForUser(like.userId);
  }

  if (isCommentNotification(notification)) {
    const comment = getCommentById(notification.commentId);
    userFullName = getFullNameForUser(comment.userId);
  }

  return {
    userFullName,
    ...notification,
  };
};

export const formatNotificationsForApiResponse = (
  notifications: NotificationResponseItem[],
): NotificationResponseItem[] => orderBy(
  [(notification: NotificationResponseItem) => new Date(notification.modifiedAt)],
  ['desc'],
  notifications.map((notification) => formatNotificationForApiResponse(notification)),
);

// dev/test private methods
/* istanbul ignore next */
export const getRandomUser = () => {
  const users = getAllUsers();
  return sample(users)!;
};

/* istanbul ignore next */
export const getAllContacts = () => db.get(CONTACT_TABLE).value();

/* istanbul ignore next */
export const getAllTransactions = () => db.get(TRANSACTION_TABLE).value();

/* istanbul ignore */
export const getBankAccountsByUserId = (userId: string) => getBankAccountsBy('userId', userId);

/* istanbul ignore next */
export const getNotificationById = (id: string): NotificationType => getNotificationBy('id', id);

/* istanbul ignore next */
export const getNotificationsByUserId = (userId: string) => getNotificationsByObj({ userId });

/* istanbul ignore next */
export const getBankTransferByTransactionId = (transactionId: string) => getBankTransferBy('transactionId', transactionId);

/* istanbul ignore next */
export const getTransactionsBy = (key: string, value: string) => getAllBy(TRANSACTION_TABLE, key, value);

/* istanbul ignore next */
export const getTransactionsByUserId = (userId: string) => getTransactionsBy('receiverId', userId);

export default db;

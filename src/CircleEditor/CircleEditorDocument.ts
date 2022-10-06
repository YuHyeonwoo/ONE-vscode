/*
 * Copyright (c) 2022 Samsung Electronics Co., Ltd. All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as flatbuffers from 'flatbuffers';
import * as vscode from 'vscode';

import { Disposable } from '../Utils/external/Dispose';

import * as Circle from './circle_schema_generated';

import * as Types from './CircleType';
import { Balloon } from '../Utils/Balloon';
import * as flexbuffers from 'flatbuffers/js/flexbuffers';

/**
 * Custom Editor Document necessary for vscode extension API
 * This class contains model object as _model variable
 * and manages its state when modification is occured.
 */
export class CircleEditorDocument extends Disposable implements vscode.CustomDocument {
  private readonly _uri: vscode.Uri;
  private _model: Circle.ModelT;
  private readonly packetSize = 1024 * 1024 * 1024;

  public get uri(): vscode.Uri {
    return this._uri;
  }
  public get model(): Circle.ModelT {
    return this._model;
  }
  public get modelData(): Uint8Array {
    let fbb = new flatbuffers.Builder(1024);
    Circle.Model.finishModelBuffer(fbb, this._model.pack(fbb));
    return fbb.asUint8Array();
  }

  static async create(uri: vscode.Uri):
    Promise<CircleEditorDocument | PromiseLike<CircleEditorDocument>> {
    let bytes = new Uint8Array(await vscode.workspace.fs.readFile(uri));
    return new CircleEditorDocument(uri, bytes);
  }

  private constructor(uri: vscode.Uri, bytes: Uint8Array) {
    super();
    this._uri = uri;
    this._model = this.loadModel(bytes);
  }

  // dispose
  private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
  public readonly onDidDispose = this._onDidDispose.event;

  // tell to webview
  public readonly _onDidChangeContent = this._register(new vscode.EventEmitter<any>());
  public readonly onDidChangeContent = this._onDidChangeContent.event;

  // tell to vscode
  private readonly _onDidChangeDocument = this._register(new vscode.EventEmitter<{
    readonly label: string,
    undo(): void,
    redo(): void,
  }>());
  public readonly onDidChangeDocument = this._onDidChangeDocument.event;

  dispose(): void {
    this._onDidDispose.fire();
    super.dispose();
  }

  private loadModel(bytes: Uint8Array): Circle.ModelT {
    let buf = new flatbuffers.ByteBuffer(bytes);
    return Circle.Model.getRootAsModel(buf).unpack();
  }

  /**
   * execute appropriate edit feature and calls notifyEdit function
   */
  makeEdit(message: any) {
    const oldModelData = this.modelData;
    switch (message.type) {
      case 'attribute':
        // TODO: implement functions to edit attributes of operator in model
        break;
      case 'tensor':
        // TODO: implement functions to edit tensors in model
        break;
      default:
        return;
    }
    const newModelData = this.modelData;
    this.notifyEdit(oldModelData, newModelData);
  }

  /**
   * calls sendModel function so that webviews can be aware of current model data
   * records old and new model for undo and redo features
   */
  notifyEdit(oldModelData: Uint8Array, newModelData: Uint8Array) {
    this.sendModel();

    this._onDidChangeDocument.fire({
      label: 'Model',
      undo: async () => {
        this._model = this.loadModel(oldModelData);
        this.sendModel();
      },
      redo: async () => {
        this._model = this.loadModel(newModelData);
        this.sendModel();
      }
    });
  }

  /**
   * send current model data to webviews with declared packetsize
   */
  sendModel(offset: number = 0) {
    if (offset > this.modelData.length - 1) {
      return;
    }

    let responseModelPath = { command: 'loadmodel', type: 'modelpath', value: this._uri.fsPath };
    this._onDidChangeContent.fire(responseModelPath);

    let responseArray = this.modelData.slice(offset, offset + this.packetSize);

    let responseModel = {
      command: 'loadmodel',
      type: 'uint8array',
      offset: offset,
      length: responseArray.length,
      total: this.modelData.length,
      responseArray: responseArray
    };

    this._onDidChangeContent.fire(responseModel);
  }

  /**
   * Called by VS Code when the user saves the document.
   */
  async save(cancellation: vscode.CancellationToken): Promise<void> {
    await this.saveAs(this.uri, cancellation);
  }

  /**
   * Called by VS Code when the user saves the document to a new location.
   */
  async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    if (cancellation.isCancellationRequested) {
      return;
    }
    await vscode.workspace.fs.writeFile(targetResource, this.modelData);
  }

  /**
   * Called by VS Code when the user calls `revert` on a document.
   */
  async revert(_cancellation: vscode.CancellationToken): Promise<void> {
    const oldModelData = this.modelData;
    const newModelData = await vscode.workspace.fs.readFile(this.uri);
    this._model = this.loadModel(newModelData);
    this.notifyEdit(oldModelData, newModelData);
  }

  /**
   * Called by VS Code to backup the edited document.
   * These backups are used to implement hot exit.
   */
  async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken):
    Promise<vscode.CustomDocumentBackup> {
    await this.saveAs(destination, cancellation);

    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // noop
        }
      }
    };
  }

  /**
   * Guess data's type (int or float)
   */
  private guessExactType(n: any) {
    if (isNaN(Number(n))) {
      return 'error';
    }

    if (Number(n) % 1 === 0) {
      return 'int';
    }
    else if (Number(n) % 1 !== 0) {
      return 'float';
    }
  }

  /**
   * Encode key and value entered in the calculator using flexbuffers.
   * Send encoded data.
   */
  public sendEncodingData(message: any) {
    let fbb = flexbuffers.builder();
    fbb.startMap();
    for (const key in message.data) {
      fbb.addKey(key);
      const val = message.data[key][0];
      const valType = message.data[key][1];
      if (valType === 'boolean') {
        if (val === 'true' || val === true) {
          fbb.add(true);
        }
        else if (val === 'false' || val === false) {
          fbb.add(false);
        }
        else {
          Balloon.error("'boolean' type must be 'true' or 'false'.", false);
          return;
        }
      }
      else if (valType === 'int') {
        const guessType = this.guessExactType(val);
        if (guessType === 'float') {
          Balloon.error("'int' type doesn't include decimal point.", false);
          return;
        }
        else if (guessType === 'error') {
          Balloon.error('it\'s not a number', false);
          return;
        }
      }
      else {
        fbb.add(String(val));
      }
    }
    fbb.end();
    const res = fbb.finish();
    const data = Array.from(res);
    let responseData = {
      command: 'responseEncodingData',
      data: data
    };
    this._onDidChangeContent.fire(responseData);
  }

  /**
   * Decode customOptions using flexbuffers when we click custom operator's node.
   * Send value's type of custom operator. 
   */
  public setCustomOpAttrT(message: any) {
    const msgData: any = message.data;
    const subgraphIdx: number = msgData._subgraphIdx;
    const operatorIdx: number = msgData._nodeIdx;
    const target = this._model.subgraphs[subgraphIdx].operators[operatorIdx].customOptions;
    const buffer = Buffer.from(target);
    const ab = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buffer.length; ++i) {
      view[i] = buffer[i];
    }
    const customObj: any = flexbuffers.toObject(ab);
    let resData: any = new Object;
    resData._subgraphIdx = subgraphIdx;
    resData._nodeIdx = operatorIdx;
    resData._type = new Object;
    for (const key in customObj) {
      let customObjDataType: any = typeof (customObj[key]);
      if (customObjDataType === 'number') {
        customObjDataType = this.guessExactType(customObj[key]);
        if (customObjDataType === 'error') {
          Balloon.error('It\'s not a number.', false);
          return;
        }
      }
      resData._type[key] = customObjDataType;
    }
    let responseData = {
      command: 'setCustomOpAttrT',
      data: resData
    };

    this._onDidChangeContent.fire(responseData);
    return;
  }

  /**
   * This function edit Tensor's name and shape, data's type of buffer, buffer's data.
   */
  private editTensor(data: any) {
    let name = data?._name;
    let subgraphIdx: number = Number(data._subgraphIdx);
    let argname: string;
    let tensorIdx: number;
    let isVariable: boolean = false;
    let tensorType;
    let tensorShape;
    let bufferData: any = null;
    if (name === undefined || subgraphIdx === undefined) {
      Balloon.error('input data is undefined', false);
      return;
    }
    const argument = data._arguments;
    argname = argument._name;
    tensorIdx = Number(argument._location);
    const isChanged: boolean = argument._isChanged;
    tensorType = argument._type._dataType;
    tensorShape = argument._type._shape._dimensions;
    if (argname === undefined || tensorIdx === undefined || tensorType === undefined || tensorShape === undefined) {
      Balloon.error('input data is undefined', false);
      return;
    }
    if (argument._initializer !== null) {
      const ini = argument._initializer;
      if (isChanged === true) {
        bufferData = ini._data;
      }
      isVariable = ini._is_variable;
    }
    tensorType = tensorType.toUpperCase();

    const targetTensor = this._model?.subgraphs[subgraphIdx]?.tensors[tensorIdx];
    if (targetTensor === undefined) {
      Balloon.error('model is undefined', false);
      return;
    }
    targetTensor.name = argname;
    if (tensorType === 'BOOLEAN') {
      tensorType = 'BOOL';
    }
    let tensorTypeNum: any = Circle.TensorType[tensorType];
    targetTensor.type = tensorTypeNum;
    targetTensor.shape = tensorShape;
    if (bufferData !== null) {
      const editBufferIdx: number = targetTensor.buffer;
      this._model.buffers[editBufferIdx].data = bufferData;
    }
    return;
  }

  /**
   * This function edits Attribute for built-in operators and custom operators.
   * If operator code is 32, encodes key and value for custom operators. and overwrites customOptions's int array.
   * Else, edits built-in operator's attributes according to Custom Type and Normal Type in CircleType.ts.
   */
  private editAttribute(data: any) {
    let subgraphIdx: number = Number(data._subgraphIdx);
    let operatorIdx: number = Number(data._nodeIdx);
    let inputTypeName: string = data.name;
    if (inputTypeName === undefined || subgraphIdx === undefined || operatorIdx === undefined) {
      Balloon.error('input data is undefined', false);
      return;
    }
    inputTypeName = inputTypeName.toUpperCase();
    let inputTypeOptionName: any = inputTypeName + 'OPTIONS';
    let operatorCode: number = 0;
    for (let i = -4; i <= 146; i++) {
      let builtinOperatorKey = Circle.BuiltinOperator[i];
      if (builtinOperatorKey === undefined) { continue; }
      let tempKey: any = Circle.BuiltinOperator[i];
      tempKey = tempKey.replaceAll('_', '');
      builtinOperatorKey = tempKey;
      builtinOperatorKey = builtinOperatorKey.toUpperCase();
      if (builtinOperatorKey === inputTypeName) {
        operatorCode = i;
        break;
      }
    }
    const operator: any = this._model.subgraphs[subgraphIdx].operators[operatorIdx];
    if (operator === undefined) {
      Balloon.error('model is undefined', false);
      return;
    }
    // built-in operator Case
    if (operatorCode !== 32) {
      //operator.builtinOptions의 키와 opetion을 비교해서 다를 경우 에러 처리
      

      
      if (inputTypeOptionName.indexOf('POOL2D') !== -1) {
        inputTypeOptionName = 'POOL2DOPTIONS';
      }
      operator.builtinOptionsType = Types.BuiltinOptionsType[inputTypeOptionName];
      const key = data._attribute.name;
      const value: any = data._attribute._value;
      const type: any = data._attribute._type;
      let targetKey: any = null;
      for (const obj in operator.builtinOptions) {
        let compKey: any = key;
        compKey = compKey.replaceAll('_', '');
        if (obj.toUpperCase() === compKey.toUpperCase()) {
          targetKey = obj;
        }
      }

      const circleTypeArr = Object.keys(Types.CircleType);
      // CircleType options in CircleType.ts
      if (circleTypeArr.find(element => element === type) !== undefined) {
        operator.builtinOptions[targetKey] = Types.CircleType[type][value];
      }
      // NormalType options in CircleType.ts
      else {
        // Array
        if (type.includes('[]')) {
          let editValue = value;
          let lastCommaIdx = value.lastIndexOf(',');
          let lastNumberIdx: number = value.length - 1;
          for (let i = value.length - 1; i >= 0; i--) {
            if (value[i] >= '0' && value[i] <= '9') {
              lastNumberIdx = i;
              break;
            }
          }
          if (lastCommaIdx > lastNumberIdx) {
            editValue = value.slice(0, lastCommaIdx);
          }
          const valArr = editValue.split(',');
          const valNumArr = [];
          for (let i = 0; i < valArr.length; i++) {
            if (valArr[i].search('0') === -1 && valArr[i].indexOf('1') === -1 && valArr[i].search('2') === -1 && valArr[i].search('3') === -1 &&
              valArr[i].search('4') === -1 && valArr[i].search('5') === -1 && valArr[i].search('6') === -1 && valArr[i].search('7') === -1 &&
              valArr[i].search('8') === -1 && valArr[i].search('9') === -1) {
              Balloon.error('Check your input array! you typed double comma (\',,\') or you didn\'t typed number', false);
              return;
            }
            else if (isNaN(Number(valArr[i]))) {
              Balloon.error('Check your input array! you didn\'t typed number', false);
              return;
            }
            valNumArr.push(Number(valArr[i]));
          }
          const resArr = new Types.NormalType[type](valNumArr);
          operator.builtinOptions[targetKey] = resArr;
        }
        // boolean type
        else if (type === 'boolean') {
          if (value === 'false') {
            operator.builtinOptions[targetKey] = false;
          }
          else if (value === 'true') {
            operator.builtinOptions[targetKey] = true;
          }
          else {
            Balloon.error("'boolean' type must be 'true' or 'false'.", false);
            return;
          }
        }
        // float type, epsilon type
        else if (type === 'float16' || type === 'float32' || type === 'float64' || type === 'float' || type === 'epsilon') {
          operator.builtinOptions[targetKey] = parseFloat(value);
        }
        else {
          operator.builtinOptions[targetKey] = Types.NormalType[type](value);
        }
      }
    }

    else if (operatorCode === 32) { // custom operator case
      operator.builtinOptionsType = 0;
      operator.builtinOPtions = null;
      const customName = data._attribute.name;
      const customKeyArray = data._attribute.keys;
      const opCodeIdx = operator.opcodeIndex;
      this._model.operatorCodes[opCodeIdx].customCode = customName;

      let fbb = flexbuffers.builder();
      fbb.startMap();
      for (const key of customKeyArray) {
        fbb.addKey(key);
        let val = data._attribute[key];
        const valType = data._attribute[key + '_type'];
        if (valType === 'boolean') {
          if (val === 'true' || val === true) {
            fbb.add(true);
          }
          else if (val === 'false' || val === false) {
            fbb.add(false);
          }
          else {
            Balloon.error("'boolean' type must be 'true' or 'false'.", false);
            return;
          }
        }
        else if (valType === 'int') {
          const guessType = this.guessExactType(val);
          if (guessType === 'float') {
            Balloon.error("'int' type doesn't include decimal point.", false);
            return;
          }
          else if (guessType === 'error') {
            Balloon.error('it\'s not a number', false);
            return;
          }
          fbb.addInt(Number(val));
        }
        else {
          fbb.add(String(val));
        }
      }
      fbb.end();
      let res = fbb.finish();
      let res2 = Array.from(res);
      operator.customOptions = res2;
    }
    return;
  }
}

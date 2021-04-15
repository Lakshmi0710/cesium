import Check from "../Core/Check.js";
import defined from "../Core/defined.js";
import deprecationWarning from "../Core/deprecationWarning.js";
import BatchTableHierarchy from "./BatchTableHierarchy.js";
import FeatureMetadata from "./FeatureMetadata.js";
import FeatureTable from "./FeatureTable.js";
import getBinaryAccessor from "./getBinaryAccessor.js";
import JsonMetadataTable from "./JsonMetadataTable.js";
import MetadataSchema from "./MetadataSchema.js";

/**
 * An object that parses the the 3D Tiles 1.0 batch table and transcodes it to
 * be compatible with feature metadata from the `EXT_feature_metadata` glTF extension
 * <p>
 * See the {@link https://github.com/CesiumGS/glTF/tree/3d-tiles-next/extensions/2.0/Vendor/EXT_feature_metadata/1.0.0|EXT_feature_metadata Extension} for glTF.
 * </p>
 *
 * @param {Object} options Object with the following properties:
 * @param {Number} options.count The number of features in the batch table.
 * @param {Object} options.batchTable The batch table JSON
 * @param {Uint8Array} options.binaryBody The batch table binary body
 * @return {FeatureMetadata} a transcoded feature metadata object
 *
 * @private
 */
export default function parseBatchTable(options) {
  //>>includeStart('debug', pragmas.debug);
  Check.typeOf.number("options.count", options.count);
  Check.typeOf.object("options.batchTable", options.batchTable);
  Check.typeOf.object("options.binaryBody", options.binaryBody);
  //>>includeEnd('debug');

  var featureCount = options.count;
  var batchTable = options.batchTable;
  var binaryBody = options.binaryBody;

  // divide properties into binary, json and hierarchy
  var partitionResults = partitionProperties(batchTable);

  var jsonMetadataTable = new JsonMetadataTable({
    count: featureCount,
    properties: partitionResults.jsonProperties,
  });

  var hierarchy = initializeHierarchy(partitionResults.extensions, binaryBody);

  var binaryResults = transcodeBinaryProperties(
    featureCount,
    partitionResults.binaryProperties,
    binaryBody
  );

  var featureTables = {
    _batchTable: new FeatureTable({
      featureTable: binaryResults.featureTableJson,
      class: binaryResults.transcodedClass,
      bufferViews: binaryResults.bufferViewsU8,
      jsonMetadataTable: jsonMetadataTable,
      batchTableHierarchy: hierarchy,
    }),
  };

  return new FeatureMetadata({
    schema: binaryResults.transcodedSchema,
    featureTables: featureTables,
    extensions: partitionResults.extensions,
    extras: partitionResults.extras,
  });
}

/**
 * Divide the batch table's properties into binary, JSON and hierarchy
 * extension as each is handled separately
 *
 * @param {Object} batchTable The batch table JSON
 * @returns {Object} The batch table divided into binary, JSON and hierarchy portions.
 *
 * @private
 */
function partitionProperties(batchTable) {
  var legacyHierarchy = batchTable.HIERARCHY;
  var extras = batchTable.extras;
  var extensions = batchTable.extensions;

  if (defined(legacyHierarchy)) {
    parseBatchTable._deprecationWarning(
      "batchTableHierarchyExtension",
      "The batch table HIERARCHY property has been moved to an extension. Use extensions.3DTILES_batch_table_hierarchy instead."
    );
    extensions = defined(extensions) ? extensions : {};
    extensions["3DTILES_batch_table_hierarchy"] = legacyHierarchy;
  }

  var jsonProperties = {};
  var binaryProperties = {};
  for (var propertyId in batchTable) {
    if (
      !batchTable.hasOwnProperty(propertyId) ||
      // these cases were handled above;
      propertyId === "HIERARCHY" ||
      propertyId === "extensions" ||
      propertyId === "extras"
    ) {
      continue;
    }

    var property = batchTable[propertyId];
    if (Array.isArray(property)) {
      jsonProperties[propertyId] = property;
    } else {
      binaryProperties[propertyId] = property;
    }
  }

  return {
    binaryProperties: binaryProperties,
    jsonProperties: jsonProperties,
    extras: extras,
    extensions: extensions,
  };
}

/**
 * Transcode the binary properties of the batch table to be compatible with
 * <code>EXT_feature_metadata</code>
 *
 * @param {Number} featureCount The number of features in the batch table
 * @param {Object.<String, Object>} binaryProperties A dictionary of property ID to property definition
 * @param {Uint8Array} binaryBody The binary body of the batch table
 * @return {Object} Transcoded data needed for constructing a {@link FeatureMetadata} object.
 *
 * @private
 */
function transcodeBinaryProperties(featureCount, binaryProperties, binaryBody) {
  var classProperties = {};
  var featureTableProperties = {};
  var bufferViewsU8 = {};
  var bufferViewCount = 0;
  for (var propertyId in binaryProperties) {
    if (!binaryProperties.hasOwnProperty(propertyId)) {
      continue;
    }
    var property = binaryProperties[propertyId];
    var binaryAccessor = getBinaryAccessor(property);

    featureTableProperties[propertyId] = {
      bufferView: bufferViewCount,
    };

    classProperties[propertyId] = transcodePropertyType(property);

    bufferViewsU8[bufferViewCount] = binaryAccessor.createArrayBufferView(
      binaryBody.buffer,
      binaryBody.byteOffset + property.byteOffset,
      featureCount
    );

    bufferViewCount++;
  }

  var schemaJson = {
    classes: {
      _batchTable: {
        properties: classProperties,
      },
    },
  };
  var transcodedSchema = new MetadataSchema(schemaJson);

  var featureTableJson = {
    class: "_batchTable",
    count: featureCount,
    properties: featureTableProperties,
  };

  return {
    featureTableJson: featureTableJson,
    bufferViewsU8: bufferViewsU8,
    transcodedSchema: transcodedSchema,
    transcodedClass: transcodedSchema.classes._batchTable,
  };
}

/**
 * Given a property definition from the batch table, compute the equivalent
 * <code>EXT_feature_metadata</code> type definition
 *
 * @param {Object} property The batch table property definition
 * @param {Object} The corresponding feature metadata property definition
 * @private
 */
function transcodePropertyType(property) {
  var componentType = transcodeComponentType(property.componentType);

  var propertyType = property.type;
  if (propertyType === "SCALAR") {
    return {
      type: componentType,
    };
  }

  // propertyType is one of VEC2, VEC3, or VEC4
  var componentCount = parseInt(propertyType.charAt(3));

  return {
    type: "ARRAY",
    componentType: componentType,
    componentCount: componentCount,
  };
}

/**
 * Convert the component type of a batch table property to the corresponding
 * type used with feature metadata
 *
 * @property {String} componentType the batch table's component type
 * @return {String} The corresponding feature metadata data type
 *
 * @private
 */
function transcodeComponentType(componentType) {
  switch (componentType) {
    case "BYTE":
      return "INT8";
    case "UNSIGNED_BYTE":
      return "UINT8";
    case "SHORT":
      return "INT16";
    case "UNSIGNED_SHORT":
      return "UINT16";
    case "INT":
      return "INT32";
    case "UNSIGNED_INT":
      return "UINT32";
    case "FLOAT":
      return "FLOAT32";
    case "DOUBLE":
      return "FLOAT64";
  }
}

/**
 * Construct a batch table hierarchy object if the 3DTILES_batch_table_hierarchy extension is present
 *
 * @param {Object} [extensions] The extensions
 * @param {Uint8Array} binaryBody The binary body of the batch table
 * @return {BatchTableHierarchy} A batch table hierarchy, or <code>undefined</code> if the extension is not present.
 *
 * @private
 */
function initializeHierarchy(extensions, binaryBody) {
  if (!defined(extensions)) {
    return undefined;
  }

  var hierarchy = extensions["3DTILES_batch_table_hierarchy"];
  if (!defined(hierarchy)) {
    return undefined;
  }

  return new BatchTableHierarchy({
    extension: hierarchy,
    binaryBody: binaryBody,
  });
}

// exposed for testing
parseBatchTable._deprecationWarning = deprecationWarning;
